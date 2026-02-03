import { Handler } from '@netlify/functions';
import { Client, validateSignature, WebhookEvent } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fetch from 'node-fetch';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { data: settings, error: settingsError } = await supabase.from('settings').select('*').single();
  if (settingsError || !settings) return { statusCode: 500, body: 'Failed to fetch settings' };

  const lineClient = new Client({
    channelAccessToken: settings.line_channel_access_token,
    channelSecret: settings.line_channel_secret,
  });

  const signature = event.headers['x-line-signature'] || '';
  if (!validateSignature(event.body || '', settings.line_channel_secret, signature)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const events: WebhookEvent[] = JSON.parse(event.body || '').events;

  for (const lineEvent of events) {
    if (lineEvent.type === 'message' && lineEvent.message.type === 'text') {
      const userId = lineEvent.source.userId!;
      const userMessage = lineEvent.message.text.trim();
      const eventId = (lineEvent as any).webhookEventId;

      // 1. 去重機制 (關鍵)：利用 user_states 表的備註欄位或專用欄位紀錄最後處理的 Event ID
      // 避免 AI 運算太久導致 LINE 重複發送請求
      const { data: userState } = await supabase.from('user_states').select('*').eq('line_user_id', userId).single();
      
      if (userState?.last_event_id === eventId) {
        console.log('Duplicate event detected, skipping.');
        continue; 
      }

      // 更新最後處理的 Event ID
      await supabase.from('user_states').upsert({ 
        line_user_id: userId, 
        last_event_id: eventId 
      });

      // 2. 關鍵字偵測
      const handoverKeywords = settings.handover_keywords
        ?.replace(/，/g, ',')
        .split(',')
        .map((k: string) => k.trim())
        .filter((k: string) => k.length > 0) || [];
      
      // 改用更精確的匹配：如果訊息完全等於關鍵字，或包含在內（但排除極短訊息誤觸）
      const matchedKeyword = handoverKeywords.find((k: string) => {
        if (k.length === 1) return userMessage === k; // 單個字必須完全相同
        return userMessage.includes(k);
      });

      if (matchedKeyword) {
        let nickname = '匿名用戶';
        try { const p = await lineClient.getProfile(userId); nickname = p.displayName; } catch (e) {}
        
        await supabase.from('user_states').upsert({ 
          line_user_id: userId, 
          nickname, 
          is_human_mode: true, 
          last_human_interaction: new Date().toISOString() 
        });

        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: '已為您轉接真人客服，請稍候。' });
        
        const agentIds = settings.agent_user_ids?.split(',').map((id: string) => id.trim()).filter(Boolean);
        if (agentIds) {
          for (const id of agentIds) {
            try { await lineClient.pushMessage(id, { type: 'text', text: `🔔 真人通知：【${nickname}】正在呼叫專人。\n觸發字：${matchedKeyword}\n原文：${userMessage}` }); } catch (e) {}
          }
        }
        continue;
      }

      // 3. 檢查目前是否在真人模式
      if (userState?.is_human_mode) {
        const last = new Date(userState.last_human_interaction).getTime();
        const timeoutMs = settings.handover_timeout_minutes * 60 * 1000;
        if (new Date().getTime() - last < timeoutMs) {
          continue; // 還在真人模式且未超時，不回覆
        }
        // 超時了，自動切回 AI
        await supabase.from('user_states').update({ is_human_mode: false }).eq('line_user_id', userId);
      }

      // 4. 呼叫 AI (不存紀錄，不傳歷史)
      if (!settings.is_ai_enabled) continue;

      let aiResult = '';
      try {
        if (settings.active_ai === 'gpt') {
          aiResult = (await callGPT(settings, userMessage)).text;
        } else {
          aiResult = await callGemini(settings, userMessage);
        }
      } catch (e: any) {
        aiResult = `❌ AI 錯誤：\n${e.message}`;
      }

      if (aiResult) {
        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: aiResult });
      }
    }
  }
  return { statusCode: 200, body: 'OK' };
};

async function callGPT(settings: any, currentMessage: string) {
  const isGPT5 = settings.gpt_model_name.includes('gpt-5');
  let fileContent = '';
  if (settings.reference_file_url) {
    try { const r = await fetch(settings.reference_file_url); if (r.ok) fileContent = await r.text(); } catch (e) {}
  }
  const systemContent = `${settings.system_prompt}\n\n參考文字：\n${settings.reference_text}\n\n檔案內容：\n${fileContent}`;

  if (isGPT5) {
    const body: any = {
      model: settings.gpt_model_name,
      input: `System: ${systemContent}\nUser: ${currentMessage}`,
      reasoning: { effort: settings.gpt_reasoning_effort || 'none' },
      text: { verbosity: settings.gpt_verbosity || 'medium' }
    };
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.gpt_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result: any = await res.json();
    if (!res.ok || result.error) throw new Error(result.error?.message || res.statusText);
    return { text: result.output?.text || '' };
  }

  const openai = new OpenAI({ apiKey: settings.gpt_api_key });
  const messages: any[] = [{ role: 'system', content: systemContent }, { role: 'user', content: currentMessage }];
  const params: any = { model: settings.gpt_model_name, messages };
  
  if (settings.gpt_model_name.startsWith('o1') || settings.gpt_model_name.startsWith('o3')) {
    params.max_completion_tokens = settings.gpt_max_tokens;
  } else {
    params.max_tokens = settings.gpt_max_tokens;
    params.temperature = settings.gpt_temperature;
  }
  
  const completion = await openai.chat.completions.create(params);
  return { text: completion.choices[0].message.content || '' };
}

async function callGemini(settings: any, currentMessage: string) {
  let filePart: any = null;
  if (settings.reference_file_url) {
    try {
      const r = await fetch(settings.reference_file_url);
      if (r.ok) {
        const b = await r.arrayBuffer();
        filePart = { inline_data: { data: Buffer.from(b).toString('base64'), mime_type: settings.reference_file_url.endsWith('.pdf') ? 'application/pdf' : 'text/plain' } };
      }
    } catch (e) {}
  }
  const userParts: any[] = [{ text: `System: ${settings.system_prompt}\nReference: ${settings.reference_text}` }];
  if (filePart) userParts.push(filePart);
  userParts.push({ text: `User: ${currentMessage}` });
  const contents = [{ role: 'user', parts: userParts }];

  const generationConfig: any = { temperature: 1.0, maxOutputTokens: settings.gemini_max_tokens };
  if (settings.gemini_model_name.includes('gemini-3')) {
    generationConfig.thinking_config = { include_thoughts: true, thinking_level: settings.gemini_thinking_level || 'high' };
  }

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${settings.gemini_model_name}:generateContent?key=${settings.gemini_api_key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig })
  });
  const result: any = await res.json();
  if (!res.ok || result.error) throw new Error(result.error?.message || 'Gemini API Error');
  return result.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || '';
}