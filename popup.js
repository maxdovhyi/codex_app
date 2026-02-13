console.log('Popup loaded');

const apiKeyEl = document.getElementById('apiKey');
const modelEl = document.getElementById('model');
const transcriptEl = document.getElementById('transcript');
const summaryEl = document.getElementById('summary');
const statusEl = document.getElementById('status');

const extractBtn = document.getElementById('extractBtn');
const copyBtn = document.getElementById('copyBtn');
const summarizeBtn = document.getElementById('summarizeBtn');

const hasExtensionApis = Boolean(
  globalThis.chrome?.storage?.local && globalThis.chrome?.tabs && globalThis.chrome?.scripting
);

if (!apiKeyEl || !modelEl || !transcriptEl || !summaryEl || !statusEl || !extractBtn || !copyBtn || !summarizeBtn) {
  console.error('UI elements not found. Check HTML ids.');
} else {
  init().catch((error) => {
    console.error('Init failed', error);
    setStatus('Ошибка инициализации расширения', true);
  });

  apiKeyEl.addEventListener('change', async () => {
    await saveToStorage({ openai_api_key: apiKeyEl.value.trim() });
  });

  modelEl.addEventListener('change', async () => {
    await saveToStorage({ openai_model: modelEl.value.trim() || 'gpt-4o-mini' });
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
      setStatus('Ошибка: транскрипт не найден', true);
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

    const model = modelEl.value.trim() || 'gpt-4o-mini';
    setStatus('Генерирую саммари...', false);

    try {
      const summary = await summarizeWithOpenAI({ transcript, apiKey, model });
      summaryEl.value = summary;
      await saveToStorage({
        openai_api_key: apiKey,
        openai_model: model,
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

  const saved = await chrome.storage.local.get(['openai_api_key', 'openai_model', 'last_transcript', 'last_summary']);
  if (saved.openai_api_key) apiKeyEl.value = saved.openai_api_key;
  if (saved.openai_model) modelEl.value = saved.openai_model;
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

async function extractTranscriptFromActiveTab() {
  if (!hasExtensionApis) {
    throw new Error('Открой расширение через chrome://extensions и страницу YouTube-видео.');
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Активная вкладка не найдена.');
    if (!tab.url || !tab.url.includes('youtube.com/watch')) {
      throw new Error('Открой страницу видео YouTube (watch) и попробуй снова.');
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        const decode = (html) => {
          const txt = document.createElement('textarea');
          txt.innerHTML = html;
          return txt.value;
        };

        const playerResponse = window.ytInitialPlayerResponse;
        const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

        if (!captionTracks || !captionTracks.length) {
          throw new Error('У этого видео нет доступной транскрипции.');
        }

        const preferred = captionTracks.find((t) => t.languageCode?.startsWith('ru')) || captionTracks[0];
        const baseUrl = preferred.baseUrl;
        if (!baseUrl) throw new Error('Не найден URL транскрипции.');

        const transcriptUrl = baseUrl.includes('fmt=json3') ? baseUrl : `${baseUrl}&fmt=json3`;

        const response = await fetch(transcriptUrl);
        if (!response.ok) {
          throw new Error('Не удалось загрузить транскрипцию с YouTube.');
        }

        const data = await response.json();
        const events = data?.events || [];

        const text = events
          .flatMap((event) => event?.segs || [])
          .map((seg) => decode(seg.utf8 || ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (!text) throw new Error('Транскрипция пустая.');

        return text;
      }
    });

    if (!result) throw new Error('Не удалось извлечь транскрипцию.');
    return result;
  } catch (error) {
    console.error('extractTranscriptFromActiveTab error', error);
    throw error;
  }
}

async function summarizeWithOpenAI({ transcript, apiKey, model }) {
  const systemPrompt = `Ты аналитик контента. Верни ответ на русском языке строго в markdown-структуре:

## 🧠 Ключевая идея
- 2-4 буллета

## 🔍 Главные инсайты
- 4-8 буллетов с эмодзи в начале каждого пункта

## 🛠️ Практические шаги
- 3-6 шагов, что сделать после просмотра

## ❓ Вопросы на подумать
- 3-5 вопросов

Пиши четко, без воды, по сути.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
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
