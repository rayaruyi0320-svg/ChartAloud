const VOICE_SOURCE =
  "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin";
let runtimePromise;
let taskQueue = Promise.resolve();
const speechCache = new Map();
const MAX_CACHED_SAMPLES = 4_000_000;
let cachedSamples = 0;

function sendSamples(id, samples, sampleRate) {
  const copy = samples.slice();
  self.postMessage(
    { id, type: "samples", samples: copy.buffer, sampleRate },
    [copy.buffer],
  );
}

function useBundledVoiceFile(baseUrl) {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const requestUrl =
      typeof input === "string" || input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : "";
    if (requestUrl === VOICE_SOURCE)
      return nativeFetch(new URL("voices/af_heart.bin", baseUrl), init);
    return nativeFetch(input, init);
  };
}

function loadRuntime(id, baseUrl) {
  runtimePromise ??= (async () => {
    useBundledVoiceFile(baseUrl);
    const [{ KokoroTTS }, { env }] = await Promise.all([
      import("kokoro-js"),
      import("@huggingface/transformers"),
    ]);
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = new URL("models/", baseUrl).href;
    env.backends.onnx.wasm.wasmPaths = new URL("wasm/", baseUrl).href;
    const progress = ({ file, loaded, total, status }) => {
      const asset = String(file || "voice model")
        .split("/")
        .at(-1);
      let message;
      if (typeof loaded === "number" && typeof total === "number" && total > 0)
        message = `Downloading ${asset} (${Math.round((loaded / total) * 100)}%).`;
      else if (status === "initiate") message = `Preparing ${asset}…`;
      if (message) self.postMessage({ id, type: "progress", message });
    };
    return KokoroTTS.from_pretrained("kokoro", {
      dtype: "q8",
      device: "wasm",
      progress_callback: progress,
    });
  })().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

async function handle({ id, type, text, baseUrl }) {
  try {
    const tts = await loadRuntime(id, baseUrl);
    if (type === "preload") {
      self.postMessage({ id, type: "ready" });
      return;
    }
    const cached = speechCache.get(text);
    if (cached) {
      speechCache.delete(text);
      speechCache.set(text, cached);
      sendSamples(id, cached.samples, cached.sampleRate);
      return;
    }
    const result = await tts.generate(text, { voice: "af_heart", speed: 0.96 });
    const audio = { samples: Float32Array.from(result.audio), sampleRate: result.sampling_rate };
    speechCache.set(text, audio);
    cachedSamples += audio.samples.length;
    while (cachedSamples > MAX_CACHED_SAMPLES && speechCache.size > 1) {
      const oldest = speechCache.keys().next().value;
      cachedSamples -= speechCache.get(oldest).samples.length;
      speechCache.delete(oldest);
    }
    sendSamples(id, audio.samples, audio.sampleRate);
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

self.onmessage = ({ data }) => {
  taskQueue = taskQueue.then(() => handle(data));
};
