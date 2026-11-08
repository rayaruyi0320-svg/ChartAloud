import { AudioEngine } from "./audioEngine.js";
import { normalizedPitch } from "./soundMapping.js";
import { toSpokenText } from "./speechText.js";
const PREFERRED_VOICES = [
  "Samantha",
  "Ava",
  "Allison",
  "Susan",
  "Nicky",
  "Victoria",
  "Microsoft Aria",
  "Microsoft Jenny",
  "Google US English",
  "Karen",
  "Moira",
  "Tessa",
  "Serena",
];

export function chooseGuideVoice(voices, selectedName = "") {
  const english = voices.filter((voice) => /^en[-_]/i.test(voice.lang));
  if (selectedName) {
    const selected = english.find((voice) => voice.name === selectedName);
    if (selected) return selected;
  }
  for (const name of PREFERRED_VOICES) {
    const match = english.find((voice) =>
      voice.name.toLowerCase().startsWith(name.toLowerCase()),
    );
    if (match) return match;
  }
  return english.find((voice) => voice.default) ?? english[0] ?? null;
}
// One owner for speech, point cues, recorded music, and cancellation tokens.
export class Playback {
  constructor({ onPoint, onStatus, onError }) {
    Object.assign(this, { onPoint, onStatus, onError });
    this.generation = 0;
    this.mapping = "linear";
    this.nodes = new Set();
    this.status = "stopped";
    this.index = 0;
    this.speechPreloadPromise = null;
    this.speechReady = false;
    this.playedDatasets = new WeakSet();
    const unlockAudio = () => {
      if (this.kind !== "speech" || this.status !== "loading") return;
      const Constructor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Constructor) return;
      this.context ??= new Constructor();
      void this.context.resume();
    };
    document.addEventListener("pointerdown", unlockAudio, { capture: true });
    document.addEventListener("keydown", unlockAudio, { capture: true });
    try {
      this.voiceName = localStorage.getItem("chartaloud.guideVoice") || "";
    } catch {
      this.voiceName = "";
    }
    this.engine = new AudioEngine({
      onStateChange: ({ status, rowIndex }) => {
        if (this.kind !== "music") return;
        if (status === "playing" && this.dataset)
          this.playedDatasets.add(this.dataset);
        this.onStatus(
          status === "loading"
            ? "Loading instrument recordings…"
            : status === "playing"
              ? "Playing your data as music."
              : status === "paused"
                ? "Music paused."
                : "Ready to play.",
        );
        if (status === "playing" && rowIndex != null) this.onPoint(rowIndex);
      },
    });
  }
  availableVoices() {
    return (
      globalThis.speechSynthesis
        ?.getVoices()
        .filter((voice) => /^en[-_]/i.test(voice.lang)) ?? []
    );
  }
  setVoice(name) {
    this.voiceName = name;
    try {
      localStorage.setItem("chartaloud.guideVoice", name);
    } catch {}
  }
  get selectedVoice() {
    return chooseGuideVoice(this.availableVoices(), this.voiceName);
  }
  dataLabel(dataset) {
    return dataset && this.playedDatasets.has(dataset)
      ? "Replay chart music"
      : "Play chart music";
  }
  get pauseLabel() {
    return (this.kind === "sequence" && this.status === "paused") ||
      (this.kind === "music" && this.engine.status === "paused")
      ? "Resume"
      : "Pause";
  }
  get canPause() {
    return (
      (this.kind === "sequence" &&
        ["playing", "paused"].includes(this.status)) ||
      (this.kind === "music" &&
        ["playing", "paused"].includes(this.engine.status))
    );
  }
  get musicLabel() {
    if (this.kind === "music" && this.engine.status === "playing")
      return "Pause music";
    if (this.kind === "music" && this.engine.status === "paused")
      return "Resume music";
    return "Play as music";
  }
  toggleData(dataset) {
    if (this.kind === "sequence") this.toggle(dataset);
    else this.sequence(dataset);
  }
  stop(completed = false) {
    this.completed = completed;
    this.generation++;
    clearTimeout(this.timer);
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {}
    }
    this.nodes.clear();
    if (this.recordedSpeech) {
      this.recordedSpeech.pause();
      this.recordedSpeech = null;
    }
    if (this.greetingUnlock) {
      document.removeEventListener("pointerdown", this.greetingUnlock, true);
      this.greetingUnlock = null;
    }
    this.kind = null;
    this.status = "stopped";
    this.engine.stopAudio();
    globalThis.speechSynthesis?.cancel();
    this.onStatus("Ready to play.");
  }
  speakGreeting(name, onEnd = () => {}) {
    if (!["home", "user", "lesson"].includes(name)) return;
    this.stop();
    const token = this.generation;
    const audio = new Audio(`/voices/welcome-${name}.wav`);
    this.recordedSpeech = audio;
    this.kind = "speech";
    this.status = "loading";
    const finish = () => {
      if (token !== this.generation) return;
      this.recordedSpeech = null;
      this.kind = null;
      this.status = "stopped";
      this.onStatus("Ready to play.");
      onEnd();
    };
    audio.onended = finish;
    audio.onerror = () => {
      this.onError("The local af_heart welcome audio could not play.");
      finish();
    };
    const play = () => {
      if (token !== this.generation) return;
      audio.play().then(() => {
        if (token !== this.generation) return;
        this.status = "speaking";
        this.onStatus("Speaking assistant response.");
      }).catch((error) => {
        if (token !== this.generation) return;
        if (error?.name === "NotAllowedError") {
          this.onStatus("Click the page to hear the local af_heart welcome.");
          this.greetingUnlock = () => {
            this.greetingUnlock = null;
            play();
          };
          document.addEventListener("pointerdown", this.greetingUnlock, {
            capture: true,
            once: true,
          });
        } else {
          this.onError(`The local af_heart welcome audio could not play: ${error?.message || error}`);
          finish();
        }
      });
    };
    play();
  }
  preloadSpeech({ reportProgress = true } = {}) {
    if (this.speechReady) return Promise.resolve();
    if (this.speechPreloadPromise) return this.speechPreloadPromise;
    const token = this.generation;
    if (reportProgress)
      this.onStatus(
        "Preparing the local English voice. Its first load may take a moment.",
      );
    this.speechPreloadPromise = import("./kokoroSpeech.js")
      .then(({ preloadSpeech }) =>
        preloadSpeech((message) => {
          if (reportProgress && token === this.generation)
            this.onStatus(message);
        }),
      )
      .then(() => {
        this.speechReady = true;
        if (reportProgress && token === this.generation)
          this.onStatus("Local English voice ready.");
      })
      .catch((error) => {
        if (token !== this.generation) return;
        const reason =
          error instanceof Error ? error.message : "unknown load error";
        this.onError(
          `The local af_heart voice could not be prepared: ${reason}. Try again after the page finishes loading.`,
        );
        if (reportProgress)
          this.onStatus(`Local af_heart voice unavailable: ${reason}`);
      })
      .finally(() => {
        this.speechPreloadPromise = null;
      });
    return this.speechPreloadPromise;
  }
  speakWithBrowser(text, retryMessage, onEnd, token) {
    if (token !== this.generation) return;
    const Speech = globalThis.SpeechSynthesisUtterance;
    if (!globalThis.speechSynthesis || !Speech) {
      this.kind = null;
      this.status = "stopped";
      const message = `${retryMessage} Spoken guidance is unavailable; the text remains on screen.`;
      this.onError(message);
      this.onStatus(message);
      onEnd();
      return;
    }
    try {
      const utterance = new Speech(text);
      const englishVoice = this.selectedVoice;
      utterance.lang = "en-US";
      utterance.voice = englishVoice;
      if (utterance.voice) utterance.lang = utterance.voice.lang;
      utterance.pitch = 1;
      utterance.rate = 0.96;
      const finish = (message = "Ready to play.") => {
        if (token !== this.generation) return;
        this.kind = null;
        this.status = "stopped";
        this.onStatus(message);
        onEnd();
      };
      utterance.onerror = (event) => {
        const failed =
          token === this.generation &&
          !["canceled", "interrupted"].includes(event.error);
        if (failed) {
          this.onError(retryMessage);
          finish(retryMessage);
        } else finish();
      };
      utterance.onend = finish;
      this.kind = "speech";
      this.status = "speaking";
      this.onStatus("Speaking with your browser's English voice.");
      globalThis.speechSynthesis.speak(utterance);
    } catch {
      if (token !== this.generation) return;
      this.kind = null;
      this.status = "stopped";
      this.onError(retryMessage);
      this.onStatus(retryMessage);
      onEnd();
    }
  }
  speak(
    text,
    enabled,
    {
      status = "Reading exact value.",
      retryMessage = "Speech could not start. Try again or read the visible value.",
      onEnd = () => {},
      bundledVoice = true,
      browserFallback = false,
    } = {},
  ) {
    this.stop();
    if (!enabled) {
      onEnd();
      return;
    }
    text = toSpokenText(text);
    if (!text) {
      onEnd();
      return;
    }
    const token = this.generation;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onEnd();
    };
    this.kind = "speech";
    this.status = "loading";
    if (!bundledVoice) {
      this.speakWithBrowser(text, retryMessage, finish, token);
      return;
    }
    if (!this.speechReady) {
      void this.preloadSpeech().then(() => {
        if (token !== this.generation) return;
        if (this.speechReady)
          this.speak(text, enabled, {
            status,
            retryMessage,
            onEnd,
            bundledVoice,
            browserFallback,
          });
        else if (browserFallback)
          this.speakWithBrowser(text, retryMessage, finish, token);
        else {
          this.onError("The local af_heart voice could not load. Please try again.");
          finish();
        }
      });
      return;
    }
    this.onStatus("Loading packaged English voice…");
    import("./kokoroSpeech.js")
      .then(({ synthesizeSpeech }) =>
        synthesizeSpeech(text, (message) => {
          if (token === this.generation) this.onStatus(message);
        }),
      )
      .then(async ({ samples, sampleRate }) => {
        if (token !== this.generation) return;
        try {
          const Constructor =
            globalThis.AudioContext || globalThis.webkitAudioContext;
          if (!Constructor)
            throw new Error("This browser does not support Web Audio.");
          this.context ??= new Constructor();
          const resume = this.context.resume();
          if (this.context.state === "suspended")
            this.onStatus("Click the page to enable the local af_heart voice.");
          await resume;
          if (token !== this.generation) return;
          if (this.context.state && this.context.state !== "running")
            throw new Error("Audio is blocked by the browser.");
          const buffer = this.context.createBuffer(
            1,
            samples.length,
            sampleRate,
          );
          buffer.copyToChannel(samples, 0);
          const source = this.context.createBufferSource();
          source.buffer = buffer;
          source.connect(this.context.destination);
          source.onended = () => {
            source.disconnect();
            this.nodes.delete(source);
            if (token !== this.generation) return;
            this.kind = null;
            this.status = "stopped";
            this.onStatus("Ready to play.");
            finish();
          };
          this.nodes.add(source);
          this.status = "speaking";
          this.onStatus(status);
          source.start();
        } catch (error) {
          if (token !== this.generation) return;
          if (browserFallback) {
            this.onError(
              "The bundled voice could not start; using your browser's English voice instead.",
            );
            this.speakWithBrowser(text, retryMessage, finish, token);
          } else {
            const reason = error instanceof Error ? error.message : String(error);
            this.onError(`The local af_heart voice could not play: ${reason}`);
            finish();
          }
        }
      })
      .catch((error) => {
        if (token !== this.generation) return;
        const reason =
          error instanceof Error ? error.message : "unknown synthesis error";
        if (browserFallback) {
          this.onError(
            `The bundled voice could not load: ${reason}. Using your browser's English voice instead.`,
          );
          this.speakWithBrowser(text, retryMessage, finish, token);
        } else {
          this.onError(`The local af_heart voice could not load: ${reason}.`);
          finish();
        }
      });
  }
  async note(value, dataset, token = this.generation) {
    try {
      const Constructor =
        globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Constructor)
        throw new Error("This browser does not support Web Audio.");
      this.context ??= new Constructor();
      await this.context.resume();
      if (token !== this.generation) return;
      if (this.context.state && this.context.state !== "running")
        throw new Error("Audio is blocked. Press a playback button to retry.");
      const values = dataset.data.map((p) => p.value),
        min = Math.min(...values),
        max = Math.max(...values);
      const pitch = normalizedPitch(value, { min, max }, this.mapping);
      const osc = this.context.createOscillator(),
        gain = this.context.createGain(),
        at = this.context.currentTime;
      osc.type = "sine";
      osc.frequency.value = 220 * 2 ** (pitch * 2);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.16, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.6);
      osc.connect(gain).connect(this.context.destination);
      osc.start(at);
      osc.stop(at + 0.65);
      this.nodes.add(osc);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
        this.nodes.delete(osc);
      };
    } catch (e) {
      if (token === this.generation) {
        this.stop();
        this.onError(e.message);
      }
    }
  }
  point(index, dataset) {
    this.stop();
    this.note(dataset.data[index].value, dataset);
  }
  sequence(dataset) {
    this.stop();
    this.playedDatasets.add(dataset);
    this.kind = "sequence";
    this.dataset = dataset;
    this.index = 0;
    this.status = "playing";
    this.tick();
  }
  tick() {
    const token = this.generation;
    this.onPoint(this.index);
    this.onStatus("Playing data sequence.");
    this.note(this.dataset.data[this.index].value, this.dataset, token);
    this.timer = setTimeout(() => {
      if (token !== this.generation || this.status !== "playing") return;
      if (++this.index < this.dataset.data.length) this.tick();
      else {
        this.stop(true);
        this.onStatus("Data sequence finished.");
      }
    }, 800);
  }
  toggle(dataset, style = this.currentStyle ?? "acoustic") {
    if (this.kind === "music") {
      if (this.engine.status === "paused")
        this.engine.resume().catch((e) => this.onError(e.message));
      else if (this.engine.status === "playing") this.engine.pause();
      return;
    }
    if (this.status === "playing") {
      this.generation++;
      clearTimeout(this.timer);
      for (const n of this.nodes) {
        try {
          n.stop();
        } catch {}
      }
      this.nodes.clear();
      this.status = "paused";
      this.onStatus("Sequence paused.");
    } else if (this.status === "paused") {
      this.status = "playing";
      this.tick();
    } else this.music(dataset, style);
  }
  music(dataset, style) {
    this.stop();
    this.currentStyle = style;
    this.dataset = dataset;
    this.kind = "music";
    const token = this.generation;
    this.engine
      .playArrangement(
        {
          title: dataset.title,
          xAxis: dataset.xAxis,
          series: [{ key: dataset.yAxis }],
          data: dataset.data.map((p) => ({
            label: p.label,
            values: { [dataset.yAxis]: p.value },
          })),
        },
        { playback: "music", style, mapping: this.mapping },
      )
      .catch((e) => {
        if (token === this.generation) this.onError(e.message);
      });
  }
}
