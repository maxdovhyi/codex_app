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

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Активная вкладка не найдена.');
  if (!tab.url || !tab.url.includes('youtube.com/')) {
    throw new Error('Открой страницу видео YouTube и попробуй снова.');
  }

  try {
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

        const getVideoIdFromUrl = () => {
          const url = new URL(window.location.href);
          const byQuery = url.searchParams.get('v');
          if (byQuery) return byQuery;
          const shortsMatch = url.pathname.match(/^\/shorts\/([^/?]+)/);
          if (shortsMatch?.[1]) return shortsMatch[1];
          const embedMatch = url.pathname.match(/^\/embed\/([^/?]+)/);
          if (embedMatch?.[1]) return embedMatch[1];
          return null;
        };

        const clickFirst = (selectors) => {
          for (const selector of selectors) {
            const node = document.querySelector(selector);
            if (node) {
              node.click();
              return true;
            }
          }
          return false;
        };

        const getTranscriptFromPanel = () => {
          const segmentSelectors = [
            'ytd-transcript-segment-renderer #segment-text',
            'ytd-transcript-segment-renderer .segment-text',
            'yt-formatted-string.segment-text'
          ];

          const lines = segmentSelectors
            .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
            .map((node) => node.textContent?.trim() || '')
            .filter(Boolean);

          if (!lines.length) return null;
          return lines.join(' ').replace(/\s+/g, ' ').trim();
        };

        const getCaptionTracks = () => {
          const playerResponse = window.ytInitialPlayerResponse;
          const fromInitial = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (Array.isArray(fromInitial) && fromInitial.length) return fromInitial;

          const ytData = window.ytInitialData;
          const playerCaptionsRenderer = ytData?.playerOverlays?.playerOverlayRenderer;
          const fromData = playerCaptionsRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer
            ?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap;

          if (Array.isArray(fromData) && fromData.length) return fromData;
          return [];
        };

        const fetchByCaptionTrack = async () => {
          const tracks = getCaptionTracks();
          const preferred = tracks.find((t) => t?.languageCode?.startsWith('ru')) || tracks[0];
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

        const openTranscriptPanel = async () => {
          const transcriptButtonSelectors = [
            'button[aria-label*="Показать текст видео"]',
            'button[aria-label*="Показать расшифровку"]',
            'button[aria-label*="Show transcript"]',
            'ytd-button-renderer button[aria-label*="текст"]',
            'ytd-menu-service-item-renderer tp-yt-paper-item[aria-label*="текст"]',
            'ytd-menu-service-item-renderer tp-yt-paper-item[aria-label*="transcript"]'
          ];

          const moreButtonSelectors = [
            '#description-inline-expander button[aria-label*="Ещё"]',
            '#description-inline-expander button[aria-label*="More"]',
            'tp-yt-paper-button#expand',
            '#expand'
          ];

          if (clickFirst(transcriptButtonSelectors)) {
            await sleep(1200);
            return true;
          }

          clickFirst(moreButtonSelectors);
          await sleep(500);

          const menuButtonSelectors = [
            'ytd-menu-renderer yt-icon-button button',
            '#above-the-fold #menu button',
            'button[aria-label="Ещё действия"]',
            'button[aria-label="More actions"]'
          ];

          clickFirst(menuButtonSelectors);
          await sleep(600);

          const menuTranscriptSelectors = [
            'ytd-menu-service-item-renderer tp-yt-paper-item[aria-label*="текст"]',
            'ytd-menu-service-item-renderer tp-yt-paper-item[aria-label*="расшифров"]',
            'ytd-menu-service-item-renderer tp-yt-paper-item[aria-label*="transcript"]',
            'ytd-menu-service-item-renderer tp-yt-paper-item'
          ];

          for (const selector of menuTranscriptSelectors) {
            const items = Array.from(document.querySelectorAll(selector));
            const target = items.find((item) => /текст|расшифров|transcript/i.test(item.textContent || ''));
            if (target) {
              target.click();
              await sleep(1200);
              return true;
            }
          }

          return false;
        };

        const videoId = getVideoIdFromUrl();
        if (!videoId) {
          return { ok: false, error: 'Не удалось определить videoId из URL.' };
        }

        let text = await fetchByCaptionTrack();
        if (text) return { ok: true, text };

        const panelOpened = await openTranscriptPanel();
        if (panelOpened) {
          await sleep(700);
          text = getTranscriptFromPanel();
          if (text) return { ok: true, text };
        }

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
