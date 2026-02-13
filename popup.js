console.log('Popup loaded');

const apiKeyEl = document.getElementById('apiKey');
const modelSelectEl = document.getElementById('modelSelect');
const contentTypeSelectEl = document.getElementById('contentTypeSelect');
const transcriptEl = document.getElementById('transcript');
const summaryEl = document.getElementById('summary');
const statusEl = document.getElementById('status');

const extractBtn = document.getElementById('extractBtn');
const copyBtn = document.getElementById('copyBtn');
const summarizeBtn = document.getElementById('summarizeBtn');
const openTabBtn = document.getElementById('openTabBtn');

const hasExtensionApis = Boolean(
  globalThis.chrome?.storage?.local && globalThis.chrome?.tabs && globalThis.chrome?.scripting
);

const LARGE_TRANSCRIPT_TOKEN_LIMIT = 30000;

const CONTENT_PROMPTS = {
  politics:
    'Проанализируй риторику, выяви скрытые смыслы, политические тезисы и возможные манипуляции. Оцени аргументацию.',
  science:
    'Упрости сложные концепции, выдели ключевые научные факты, теории и доказательства. Сохраняй точность терминов.',
  tutorial:
    'Сделай пошаговый алгоритм действий. Выдели список инструментов/методов и финальный результат.',
  general: 'Сделай глубокий анализ, выдели 5 главных инсайтов и итоговый вывод.'
};

if (
  !apiKeyEl ||
  !modelSelectEl ||
  !contentTypeSelectEl ||
  !transcriptEl ||
  !summaryEl ||
  !statusEl ||
  !extractBtn ||
  !copyBtn ||
  !summarizeBtn ||
  !openTabBtn
) {
  console.error('UI elements not found. Check HTML ids.');
} else {
  init().catch((error) => {
    console.error('Init failed', error);
    setStatus('Ошибка инициализации расширения', true);
  });

  apiKeyEl.addEventListener('change', async () => {
    await saveToStorage({ openai_api_key: apiKeyEl.value.trim() });
  });

  modelSelectEl.addEventListener('change', async () => {
    await saveToStorage({ openai_model: modelSelectEl.value || 'gpt-5-mini' });
  });

  contentTypeSelectEl.addEventListener('change', async () => {
    await saveToStorage({ openai_content_type: contentTypeSelectEl.value || 'general' });
  });

  extractBtn.addEventListener('click', async () => {
    setStatus('Получаю транскрипцию...', false);
    try {
      const text = await extractTranscriptFromActiveTab();
      transcriptEl.value = text;
      await saveToStorage({ last_transcript: text });
      setStatus('Транскрипция успешно получена ✅');
    } catch (error) {
      console.error('Transcript extraction failed', error);
      setStatus(error?.message || 'Ошибка: транскрипт не найден', true);
    }
  });

  copyBtn.addEventListener('click', async () => {
    try {
      const text = transcriptEl.value.trim();
      if (!text) {
        setStatus('Сначала получи или вставь транскрипцию.', true);
        return;
      }
      await navigator.clipboard.writeText(text);
      setStatus('Транскрипция скопирована в буфер 📋');
    } catch (error) {
      console.error('Copy failed', error);
      setStatus('Ошибка копирования транскрипции', true);
    }
  });

  openTabBtn.addEventListener('click', () => {
    const summary = summaryEl.value.trim();
    if (!summary) {
      setStatus('Сначала сгенерируй саммари, чтобы открыть его в новой вкладке.', true);
      return;
    }

    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      setStatus('Браузер заблокировал новую вкладку. Разреши pop-up для расширения.', true);
      return;
    }

    const escaped = escapeHtml(summary);
    const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Summary</title>
  <style>
    body {
      margin: 0;
      padding: 24px;
      background: #0f172a;
      color: #e5e7eb;
      font-family: 'Segoe UI', sans-serif;
      font-size: 22px;
    }
    main {
      max-width: 900px;
      margin: 0 auto;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    h2 {
      color: #93c5fd;
      margin: 20px 0 8px;
      font-size: 1.15em;
    }
  </style>
</head>
<body>
  <main id="content">${escaped}</main>
  <script>
    (() => {
      const content = document.getElementById('content');
      if (!content) return;

      let html = content.innerHTML;
      html = html.replace(/^##\s+(.+)$/gm, '<h2>$1<\/h2>');
      html = html.replace(/\*\*(.*?)\*\*/g, '<strong style="color: #fbbf24;">$1<\/strong>');
      content.innerHTML = html;
    })();
  <\/script>
</body>
</html>`;

    tab.document.open();
    tab.document.write(html);
    tab.document.close();
  });

  summarizeBtn.addEventListener('click', async () => {
    const transcript = transcriptEl.value.trim();
    if (!transcript) {
      setStatus('Добавь транскрипцию перед саммари.', true);
      return;
    }

    const apiKey = apiKeyEl.value.trim();
    if (!apiKey) {
      setStatus('Укажи OpenAI API key.', true);
      return;
    }

    const model = modelSelectEl.value || 'gpt-5-mini';
    const contentType = contentTypeSelectEl.value || 'general';
    const estimatedTokens = estimateTokenCount(transcript);

    if (estimatedTokens > LARGE_TRANSCRIPT_TOKEN_LIMIT && (model === 'gpt-5.2-pro' || model === 'gpt-5.2-instant')) {
      setStatus(
        'Слишком большой текст для этой модели, возможна ошибка лимитов. Рекомендую gpt-5-mini',
        true
      );
      return;
    }

    setStatus('Генерирую саммари...', false);

    try {
      const summary = await summarizeWithOpenAI({ transcript, apiKey, model, contentType });
      summaryEl.value = summary;
      await saveToStorage({
        openai_api_key: apiKey,
        openai_model: model,
        openai_content_type: contentType,
        last_summary: summary
      });
      setStatus('Саммари готово ✨');
    } catch (error) {
      console.error('Summarization failed', error);
      setStatus(error.message || 'Ошибка генерации саммари', true);
    }
  });
}

async function init() {
  if (!hasExtensionApis) {
    setStatus('Режим предпросмотра: API Chrome доступны только внутри расширения.', true);
    return;
  }

  const saved = await chrome.storage.local.get([
    'openai_api_key',
    'openai_model',
    'openai_content_type',
    'last_transcript',
    'last_summary'
  ]);

  if (saved.openai_api_key) apiKeyEl.value = saved.openai_api_key;
  modelSelectEl.value = saved.openai_model || 'gpt-5-mini';
  contentTypeSelectEl.value = saved.openai_content_type || 'general';
  if (saved.last_transcript) transcriptEl.value = saved.last_transcript;
  if (saved.last_summary) summaryEl.value = saved.last_summary;
}

async function saveToStorage(payload) {
  if (!hasExtensionApis) return;
  await chrome.storage.local.set(payload);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('ok', !isError);
  statusEl.classList.toggle('err', isError);
}

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function estimateTokenCount(text) {
  return Math.ceil((text || '').length / 4);
}

async function extractTranscriptFromActiveTab() {
  if (!hasExtensionApis) {
    throw new Error('Открой расширение через chrome://extensions и страницу YouTube-видео.');
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Активная вкладка не найдена.');
  if (!tab.url || !tab.url.includes('youtube.com/watch')) {
    throw new Error('Открой страницу видео YouTube (watch) и попробуй снова.');
  }

  const [execution] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const decode = (html) => {
        const txt = document.createElement('textarea');
        txt.innerHTML = html;
        return txt.value;
      };

      const transcriptFromTracklist = async () => {
        const playerResponse = window.ytInitialPlayerResponse;
        const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (!tracks.length) return null;

        const preferred =
          tracks.find((track) => track?.languageCode?.startsWith('en')) ||
          tracks.find((track) => track?.languageCode?.startsWith('ru')) ||
          tracks[0];

        const baseUrl = preferred?.baseUrl;
        if (!baseUrl) return null;

        const transcriptUrl = baseUrl.includes('fmt=json3') ? baseUrl : `${baseUrl}&fmt=json3`;
        const response = await fetch(transcriptUrl);
        if (!response.ok) return null;

        const data = await response.json();
        const text = (data?.events || [])
          .flatMap((event) => event?.segs || [])
          .map((seg) => decode(seg?.utf8 || ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        return text || null;
      };

      const transcriptFromUiFallback = async () => {
        const clickByText = (selector, regex) => {
          const nodes = Array.from(document.querySelectorAll(selector));
          const target = nodes.find((node) => regex.test(node.textContent || '') || regex.test(node.getAttribute('aria-label') || ''));
          if (target) {
            target.click();
            return true;
          }
          return false;
        };

        const clickedMore =
          clickByText('button, tp-yt-paper-item, a', /(^|\s)more($|\s)|ещё/i) ||
          clickByText('#expand, tp-yt-paper-button#expand', /.*/);

        if (clickedMore) {
          await sleep(400);
        }

        const clickedTranscript = clickByText('button, tp-yt-paper-item, ytd-menu-service-item-renderer', /show transcript|транскрип|расшифров|текст/i);
        if (!clickedTranscript) return null;

        await sleep(1200);

        const segments = Array.from(document.querySelectorAll('.segment-text'))
          .map((node) => node.textContent?.trim() || '')
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        return segments || null;
      };

      const direct = await transcriptFromTracklist();
      if (direct) return { ok: true, text: direct };

      const fallback = await transcriptFromUiFallback();
      if (fallback) return { ok: true, text: fallback };

      return {
        ok: false,
        error: 'Транскрипция не найдена. Пожалуйста, включи субтитры на самом видео.'
      };
    }
  });

  const result = execution?.result;
  if (!result?.ok || !result?.text) {
    throw new Error(result?.error || 'Не удалось извлечь транскрипцию.');
  }

  return result.text;
}

function getSystemPrompt() {
  return `Ты — ведущий аналитик и топовый эксперт. Твоя задача — сделать МАКСИМАЛЬНО качественное и наглядное саммари.

Стиль: Дерзкий, инсайтовый, экспертный.

Оформление: Используй много жирного шрифта для акцентов, обилие тематических эмодзи.

Структура:
## 🚀 ГЛАВНЫЙ ИНСАЙТ (Суть одной фразой)

## 💎 КЛЮЧЕВЫЕ ТЕЗИСЫ (Самое мясо с примерами из видео, без придумок)

## 🛠 ПРАКТИЧЕСКИЙ ЭКСПЛОЙТ (Как это применить на практике прямо сейчас)

## ⚠️ КРИТИЧЕСКИЙ РАЗБОР (Где автор видео может ошибаться или что он упустил)

Правило: Пиши только то, что реально было в видео. Никакой воды.`;
}

async function summarizeWithOpenAI({ transcript, apiKey, model }) {
  const systemPrompt = getSystemPrompt();

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 1,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Сделай саммари этого видео по транскрипции:\n\n${transcript}`
        }
      ]
    })
  });

  const payload = await res.json();
  if (!res.ok) {
    const msg = payload?.error?.message || 'Ошибка запроса к OpenAI.';
    throw new Error(msg);
  }

  const answer = payload?.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error('OpenAI вернул пустой ответ.');
  return answer;
}
