import { Handler } from '@netlify/functions';
import { Client, validateSignature, WebhookEvent } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { data: settings, error: settingsError } = await supabase
    .from('settings')
    .select('*')
    .single();

  if (settingsError || !settings) {
    return { statusCode: 500, body: 'Failed to fetch settings' };
  }

  const lineConfig = {
    channelAccessToken: settings.line_channel_access_token,
    channelSecret: settings.line_channel_secret,
  };

  const signature = event.headers['x-line-signature'] || '';
  if (!validateSignature(event.body || '', lineConfig.channelSecret, signature)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const lineClient = new Client(lineConfig);
  const events: WebhookEvent[] = JSON.parse(event.body || '').events;

  for (const lineEvent of events) {
    if (lineEvent.type === 'message' && lineEvent.message.type === 'text') {
      const userId = lineEvent.source.userId!;
      const userMessage = lineEvent.message.text;
      const eventId = (lineEvent as any).webhookEventId;

      const { data: existingLog } = await supabase
        .from('chat_logs')
        .select('id')
        .eq('webhook_event_id', eventId)
        .single();

      if (existingLog) continue;

      await supabase.from('chat_logs').insert({
        line_user_id: userId,
        webhook_event_id: eventId,
        message: userMessage,
        sender: 'user',
      });

      const { data: userState } = await supabase
        .from('user_states')
        .select('*')
        .eq('line_user_id', userId)
        .single();

      const handoverKeywords = settings.handover_keywords.split(',').map((k: string) => k.trim());
      const isKeywordHit = handoverKeywords.some((k: string) => userMessage.includes(k));

      if (isKeywordHit) {
        let nickname = '匿名用戶';
        try {
          const profile = await lineClient.getProfile(userId);
          nickname = profile.displayName;
        } catch (e) {}

        await supabase.from('user_states').upsert({
          line_user_id: userId,
          nickname: nickname,
          is_human_mode: true,
          last_human_interaction: new Date().toISOString(),
        });

        await lineClient.replyMessage(lineEvent.replyToken, {
          type: 'text',
          text: `已為您轉接真人客服，請稍候。`,
        });

        const agentIds = settings.agent_user_ids?.split(',').map((id: string) => id.trim()).filter(Boolean);
        if (agentIds) {
          for (const agentId of agentIds) {
            try {
              await lineClient.pushMessage(agentId, {
                type: 'text',
                text: `🔔 真人客服通知：\n用戶【${nickname}】(ID: ${userId}) 正在呼叫專人服務。`
              });
            } catch (e) {}
          }
        }
        continue;
      }

      if (userState?.is_human_mode) {
        const lastInteraction = new Date(userState.last_human_interaction).getTime();
        const now = new Date().getTime();
        if (now - lastInteraction < settings.handover_timeout_minutes * 60 * 1000) continue;
        await supabase.from('user_states').upsert({ line_user_id: userId, is_human_mode: false });
      }

      if (!settings.is_ai_enabled) continue;

      const { data: contextLogs } = await supabase
        .from('chat_logs')
        .select('message, sender, ai_response_id')
        .eq('line_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      const history = contextLogs?.reverse() || [];

      let aiResult: { text: string, id?: string } = { text: '' };
      try {
        if (settings.active_ai === 'gpt') {
          aiResult = await callGPT(settings, history, userMessage);
        } else {
          const text = await callGemini(settings, history, userMessage);
          aiResult = { text };
        }
      } catch (aiError: any) {
        aiResult = { text: `❌ AI 處理失敗：\n${aiError.message}` };
      }

      if (aiResult.text) {
        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: aiResult.text });
        await supabase.from('chat_logs').insert({
          line_user_id: userId,
          message: aiResult.text,
          sender: 'ai',
          ai_type: settings.active_ai,
          ai_response_id: aiResult.id
        });
      }
    }
  }
  return { statusCode: 200, body: 'OK' };
};

async function callGPT(settings: any, history: any[], currentMessage: string) {
  const isGPT5 = settings.gpt_model_name.includes('gpt-5');
  let fileContent = '';
  if (settings.reference_file_url) {
    try {
      const response = await fetch(settings.reference_file_url);
      if (response.ok) fileContent = await response.text();
    } catch (e) {}
  }

  const systemContent = `${settings.system_prompt}\n\n參考文字：\n${settings.reference_text}\n\n檔案內容：\n${fileContent}`;

  if (isGPT5) {
    try {
      const lastAIResponse = [...history].reverse().find(h => h.sender === 'ai' && h.ai_response_id);
      const body: any = {
        model: settings.gpt_model_name,
        input: `System Instruction: ${systemContent}\n\nUser Question: ${currentMessage}`,
        reasoning: { effort: settings.gpt_reasoning_effort || 'none' },
        text: { verbosity: settings.gpt_verbosity || 'medium' }
      };
      if (lastAIResponse) body.previous_response_id = lastAIResponse.ai_response_id;

      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.gpt_api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result: any = await res.json();
      if (!res.ok || result.error) throw new Error(result.error?.message || res.statusText);
      return { text: result.output?.text || '', id: result.id };
    } catch (e: any) {
      if (e.message.includes('GPT-5 API')) throw e;
    }
  }

  const openai = new OpenAI({ apiKey: settings.gpt_api_key });
  const messages: any[] = [{ role: 'system', content: systemContent }];
  for (const h of history) {
    messages.push({ role: h.sender === 'user' ? 'user' : 'assistant', content: h.message });
  }
  messages.push({ role: 'user', content: currentMessage });

  const completion = await openai.chat.completions.create({
    model: settings.gpt_model_name,
    messages: messages,
    temperature: settings.gpt_temperature,
    max_tokens: settings.gpt_max_tokens,
  });
  return { text: completion.choices[0].message.content || '', id: completion.id };
}

async function callGemini(settings: any, history: any[], currentMessage: string) {
  const genAI = new GoogleGenerativeAI(settings.gemini_api_key);
  const model = genAI.getGenerativeModel({ model: settings.gemini_model_name });
  let filePart: any = null;
  if (settings.reference_file_url) {
    try {
      const response = await fetch(settings.reference_file_url);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const base64Data = Buffer.from(buffer).toString('base64');
        filePart = { inlineData: { data: base64Data, mimeType: settings.reference_file_url.endsWith('.pdf') ? 'application/pdf' : 'text/plain' } };
      }
    } catch (e) {}
  }

  const chat = model.startChat({
    history: history.map(h => ({ role: h.sender === 'user' ? 'user' : 'model', parts: [{ text: h.message }] })),
    generationConfig: { temperature: settings.gemini_temperature, maxOutputTokens: settings.gemini_max_tokens },
  });

  const promptParts: any[] = [{ text: `System: ${settings.system_prompt}\nReference: ${settings.reference_text}` }];
  if (filePart) promptParts.push(filePart);
  promptParts.push({ text: `User: ${currentMessage}` });
  
  const result = await chat.sendMessage(promptParts);
  const response = await result.response;
  return response.text();
}