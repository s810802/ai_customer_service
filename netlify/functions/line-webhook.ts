import { Handler } from '@netlify/functions';
import { Client, validateSignature, WebhookEvent } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

// ... (rest of the initial parts)
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // 1. Fetch Settings from Supabase
  const { data: settings, error: settingsError } = await supabase
    .from('settings')
    .select('*')
    .single();

  if (settingsError || !settings) {
    console.error('Settings error:', settingsError);
    return { statusCode: 500, body: 'Failed to fetch settings' };
  }

  const lineConfig = {
    channelAccessToken: settings.line_channel_access_token,
    channelSecret: settings.line_channel_secret,
  };

  // 2. Validate LINE Signature
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

      // Log user message
      await supabase.from('chat_logs').insert({
        line_user_id: userId,
        message: userMessage,
        sender: 'user',
      });

      // 3. Handle Human Handover Mode
      const { data: userState } = await supabase
        .from('user_states')
        .select('*')
        .eq('line_user_id', userId)
        .single();

      const handoverKeywords = settings.handover_keywords.split(',').map((k: string) => k.trim());
      const isKeywordHit = handoverKeywords.some((k: string) => userMessage.includes(k));

      if (isKeywordHit) {
        await supabase.from('user_states').upsert({
          line_user_id: userId,
          is_human_mode: true,
          last_human_interaction: new Date().toISOString(),
        });
        await lineClient.replyMessage(lineEvent.replyToken, {
          type: 'text',
          text: '已為您轉接真人客服，請稍候。',
        });
        continue;
      }

      // Check if human mode should timeout
      if (userState?.is_human_mode) {
        const lastInteraction = new Date(userState.last_human_interaction).getTime();
        const now = new Date().getTime();
        const timeoutMs = settings.handover_timeout_minutes * 60 * 1000;

        if (now - lastInteraction < timeoutMs) {
          // Still in human mode
          continue;
        } else {
          // Timeout, back to AI
          await supabase.from('user_states').upsert({
            line_user_id: userId,
            is_human_mode: false,
          });
        }
      }

      // 4. Check if AI is enabled
      if (!settings.is_ai_enabled) continue;

      // 5. Get Context (Last 5 messages)
      const { data: contextLogs } = await supabase
        .from('chat_logs')
        .select('message, sender')
        .eq('line_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);

      const history = contextLogs?.reverse() || [];

      // 6. Call AI
      let aiResult: { text: string, id?: string } = { text: '' };
      if (settings.active_ai === 'gpt') {
        aiResult = await callGPT(settings, history, userMessage);
      } else {
        const text = await callGemini(settings, history, userMessage);
        aiResult = { text };
      }

      // 7. Reply and Log
      if (aiResult.text) {
        await lineClient.replyMessage(lineEvent.replyToken, {
          type: 'text',
          text: aiResult.text,
        });

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
  
  // Fetch reference file if exists
  let fileContent = '';
  if (settings.reference_file_url) {
    try {
      const response = await fetch(settings.reference_file_url);
      if (response.ok) fileContent = await response.text();
    } catch (e) { console.error('Fetch file error:', e); }
  }

  const systemContent = `${settings.system_prompt}\n\n參考文字：\n${settings.reference_text}\n\n檔案內容參考：\n${fileContent}`;

  if (isGPT5) {
    // 使用新的 Responses API (GPT-5 專用)
    const lastAIResponse = [...history].reverse().find(h => h.sender === 'ai' && h.ai_response_id);
    
    const body: any = {
      model: settings.gpt_model_name,
      input: `System: ${systemContent}\n\nUser: ${currentMessage}`,
      reasoning: { effort: settings.gpt_reasoning_effort || 'none' },
      text: { verbosity: settings.gpt_verbosity || 'medium' }
    };

    // 傳遞 CoT (Chain of Thought) 以提升智力
    if (lastAIResponse) {
      body.previous_response_id = lastAIResponse.ai_response_id;
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.gpt_api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const result: any = await response.json();
    return {
      text: result.output?.text || '',
      id: result.id
    };
  } else {
    // 傳統 Chat Completions API (GPT-4 以前)
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

    return {
      text: completion.choices[0].message.content || '',
      id: completion.id
    };
  }
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
        const mimeType = settings.reference_file_url.endsWith('.pdf') ? 'application/pdf' : 'text/plain';
        
        filePart = {
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        };
      }
    } catch (e) {
      console.error('Fetch file error:', e);
    }
  }

  const chat = model.startChat({
    history: history.map(h => ({
      role: h.sender === 'user' ? 'user' : 'model',
      parts: [{ text: h.message }],
    })),
    generationConfig: {
      temperature: settings.gemini_temperature,
      maxOutputTokens: settings.gemini_max_tokens,
    },
  });

  const promptParts: any[] = [
    { text: `System Instructions: ${settings.system_prompt}\n\nReference Info: ${settings.reference_text}` }
  ];

  if (filePart) {
    promptParts.push(filePart);
  }

  promptParts.push({ text: `User Message: ${currentMessage}` });
  
  const result = await chat.sendMessage(promptParts);
  const response = await result.response;
  return response.text();
}
