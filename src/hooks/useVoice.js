import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api.js";

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

export function useVoice() {
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState("");

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const audioRef = useRef(null);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    setError("");
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      setError("Microphone not available in this browser.");
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsListening(true);
      return true;
    } catch (err) {
      console.error("Mic error", err);
      setError(err?.message || "Could not access microphone.");
      stopStream();
      return false;
    }
  }, [stopStream]);

  const stop = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setIsListening(false);
      stopStream();
      return null;
    }

    setIsProcessing(true);

    const transcriptPromise = new Promise((resolve) => {
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        chunksRef.current = [];
        stopStream();

        if (blob.size < 800) {
          setIsProcessing(false);
          resolve("");
          return;
        }

        try {
          const formData = new FormData();
          const ext = (recorder.mimeType || "audio/webm").includes("mp4") ? "mp4" : "webm";
          formData.append("audio", blob, `intake.${ext}`);

          const response = await apiFetch("/api/stt", {
            method: "POST",
            body: formData,
          });
          const data = await response.json();
          if (!response.ok) {
            setError(data?.error || "Transcription failed.");
            resolve("");
          } else {
            resolve(data.transcript || "");
          }
        } catch (err) {
          console.error("STT request failed", err);
          setError("Transcription request failed.");
          resolve("");
        } finally {
          setIsProcessing(false);
        }
      };
    });

    recorder.stop();
    setIsListening(false);
    return transcriptPromise;
  }, [stopStream]);

  const speak = useCallback(async (text) => {
    if (!text) return;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }

    try {
      setIsSpeaking(true);
      const response = await apiFetch("/api/tts", {
        method: "POST",
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data?.error || "TTS failed.");
        setIsSpeaking(false);
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setIsSpeaking(false);
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        setIsSpeaking(false);
      };
      await audio.play();
    } catch (err) {
      console.error("TTS error", err);
      setError("Playback failed.");
      setIsSpeaking(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      stopStream();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [stopStream]);

  return { start, stop, speak, isListening, isProcessing, isSpeaking, error };
}
