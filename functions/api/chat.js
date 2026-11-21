/**
 * 追光 · Cloudflare Pages Function —— /api/chat
 * ---------------------------------------------------------------
 * 这是线上版本的后端代理，对应本地的 server.js。
 *
 * 路由：functions/api/chat.js  ->  https://你的域名/api/chat
 * 密钥：从 Cloudflare 后台的环境变量 DEEPSEEK_API_KEY 读取，
 *       不写在这里、不提交到 GitHub、不下发到浏览器。
 *
 * 你在 Cloudflare 后台配置好 DEEPSEEK_API_KEY 并重新部署后，
 * 前端会自动走这个接口，线上 AI 功能即恢复。
 */

// 把错误信息里可能带出的 Key 片段彻底抹掉
function scrubKey(message, apiKey) {
  let out = String(message || '');
  if (apiKey) {
    out = out.split(apiKey).join('****');
    if (apiKey.length >= 6) out = out.split(apiKey.slice(-6)).join('****');
    if (apiKey.length >= 4) out = out.split(apiKey.slice(-4)).join('****');
  }
  return out;
}

// 清洗 & 限制对话内容，防止滥用
function sanitizeMessages(systemPrompt, userMessage, history) {
  const sys = String(systemPrompt || '').slice(0, 4000);
  const user = String(userMessage || '').slice(0, 2000);

  const cleanHistory = [];
  if (Array.isArray(history)) {
    for (const item of history.slice(-16)) {
      if (!item) continue;
      const role = item.role === 'user' ? 'user'
                 : item.role === 'assistant' ? 'assistant' : null;
      if (!role) continue;
      const content = String(item.content || '').slice(0, 2000);
      if (content) cleanHistory.push({ role, content });
    }
  }
  return [{ role: 'system', content: sys }, ...cleanHistory, { role: 'user', content: user }];
}

function json(res, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export async function onRequestPost(context) {
  let payload;
  try {
    payload = await context.request.json();
  } catch (_) {
    return json(null, 400, { error: '请求格式不正确' });
  }

  const userMessage = payload && payload.userMessage;
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    return json(null, 400, { error: '缺少提问内容' });
  }
  if (!payload.systemPrompt || typeof payload.systemPrompt !== 'string') {
    return json(null, 400, { error: '缺少系统设定' });
  }

  // 从 Cloudflare 环境变量读取密钥（Production 与 Preview 都要配置）
  const apiKey = (context.env && context.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) {
    return json(null, 503, {
      error: '线上服务还没配置 DEEPSEEK_API_KEY。请在 Cloudflare 项目的 Settings → Environment variables 添加后重新部署。'
    });
  }

  const messages = sanitizeMessages(payload.systemPrompt, userMessage, payload.history);

  try {
    const upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: messages,
        temperature: 0.7,
        max_tokens: 1500,
        stream: false
      })
    });

    let data;
    try { data = await upstream.json(); }
    catch (_) { return json(null, 502, { error: '大模型返回了无法解析的内容' }); }

    if (!upstream.ok) {
      const msg = data && data.error && data.error.message;
      return json(null, 502, { error: scrubKey(msg || ('上游服务异常（' + upstream.status + '）'), apiKey) });
    }

    const reply = data && data.choices && data.choices[0]
      && data.choices[0].message && data.choices[0].message.content;
    if (!reply) return json(null, 502, { error: '大模型没有返回内容' });

    return json(null, 200, { reply });
  } catch (e) {
    return json(null, 502, { error: scrubKey(e && e.message, apiKey) || 'AI 服务暂时不可用' });
  }
}

// 跨域预检（同源部署用不到，保留以便本地调试直连）
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
  });
}
