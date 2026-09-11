'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { recorderNext, type RecorderEvent, type RecorderState } from '../src/domain/voice.ts';
import { VOICE_MAX_DURATION_MS, VOICE_MIN_DURATION_MS } from '../src/domain/types.ts';

export interface RecordingResult {
  readonly blob: Blob;
  readonly durationMs: number;
  readonly mimeType: string;
}

/**
 * The capture UI is driven by the *domain* state machine, so the browser flow
 * and the engine cannot drift apart: every button is enabled exactly when
 * `recorderNext` says the transition is legal.
 *
 * Permission denial is recoverable and degrades to text — typed content is
 * never discarded because the microphone was refused.
 */
export const VoiceRecorder = ({
  onReady,
  onFallbackToText,
}: {
  onReady: (result: RecordingResult) => void;
  onFallbackToText: () => void;
}) => {
  const [state, setState] = useState<RecorderState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);

  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const pausedMsRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const analyserRef = useRef<AnalyserNode | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);

  /** Apply a transition only when the domain says it is legal. */
  const advance = useCallback((event: RecorderEvent): RecorderState | undefined => {
    let next: RecorderState | undefined;
    setState((current) => {
      const result = recorderNext(current, event);
      if (!result.ok) return current;
      next = result.value;
      return result.value;
    });
    return next;
  }, []);

  const can = (event: RecorderEvent): boolean => recorderNext(state, event).ok;

  const stopMeter = useCallback(() => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;
    analyserRef.current = undefined;
    setLevel(0);
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
  }, []);

  useEffect(
    () => () => {
      if (tickRef.current) clearInterval(tickRef.current);
      stopMeter();
      releaseStream();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl, releaseStream, stopMeter],
  );

  const runMeter = (stream: MediaStream): void => {
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      analyserRef.current = analyser;
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const sample = (): void => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(buffer);
        const average = buffer.reduce((sum, value) => sum + value, 0) / buffer.length;
        setLevel(Math.min(100, Math.round((average / 160) * 100)));
        frameRef.current = requestAnimationFrame(sample);
      };
      sample();
    } catch {
      // A level meter is decoration; losing it must not break recording.
    }
  };

  const requestPermission = async (): Promise<void> => {
    setError(undefined);
    advance('request_permission');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      advance('permission_granted');
    } catch {
      advance('permission_denied');
      setError('Ragers could not use your microphone. You can type instead.');
    }
  };

  const startRecording = (): void => {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    pausedMsRef.current = 0;

    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(blob);
      });
      advance('preview');
    };

    recorder.start(250);
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    advance('start');
    runMeter(stream);

    tickRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current - pausedMsRef.current;
      setElapsedMs(elapsed);
      // The cap is enforced here and again server-side.
      if (elapsed >= VOICE_MAX_DURATION_MS) stopRecording();
    }, 100);
  };

  const stopRecording = (): void => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = undefined;
    stopMeter();
    if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop();
    advance('stop');
  };

  const pauseRecording = (): void => {
    recorderRef.current?.pause();
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = undefined;
    stopMeter();
    advance('pause');
  };

  const resumeRecording = (): void => {
    const resumedAt = Date.now();
    recorderRef.current?.resume();
    advance('resume');
    if (streamRef.current) runMeter(streamRef.current);
    tickRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current - pausedMsRef.current);
    }, 100);
    pausedMsRef.current += Date.now() - resumedAt;
  };

  const reRecord = (): void => {
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return undefined;
    });
    setElapsedMs(0);
    advance('re_record');
  };

  const submit = (): void => {
    if (elapsedMs < VOICE_MIN_DURATION_MS) {
      setError('That recording is too short. Try again.');
      return;
    }
    const blob = new Blob(chunksRef.current, { type: recorderRef.current?.mimeType || 'audio/webm' });
    advance('submit');
    releaseStream();
    onReady({ blob, durationMs: elapsedMs, mimeType: 'audio/webm' });
  };

  const seconds = Math.floor(elapsedMs / 1000);
  const label: Record<RecorderState, string> = {
    idle: 'Ready when you are',
    permission_pending: 'Waiting for microphone access…',
    permission_denied: 'Microphone unavailable',
    ready: 'Microphone ready',
    recording: 'Recording',
    paused: 'Paused',
    stopped: 'Finishing up…',
    preview: 'Have a listen',
    submitted: 'Attached',
  };

  return (
    <div className="recorder">
      <div className="recorder-status">
        <span className="recorder-dot" data-live={state === 'recording'} aria-hidden="true" />
        <span role="status" aria-live="polite">{label[state]}</span>
        <span className="recorder-elapsed">
          {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
        </span>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="recorder-controls">
        {can('request_permission') ? (
          <button type="button" className="btn btn-ghost" onClick={requestPermission}>
            {state === 'permission_denied' ? 'Try microphone again' : 'Use microphone'}
          </button>
        ) : null}

        {can('start') ? (
          <button type="button" className="btn btn-primary" onClick={startRecording}>
            Start recording
          </button>
        ) : null}

        {can('pause') ? (
          <button type="button" className="btn btn-ghost" onClick={pauseRecording}>
            Pause
          </button>
        ) : null}

        {can('resume') ? (
          <button type="button" className="btn btn-ghost" onClick={resumeRecording}>
            Resume
          </button>
        ) : null}

        {can('stop') ? (
          <button type="button" className="btn btn-primary" onClick={stopRecording}>
            Stop
          </button>
        ) : null}

        {can('re_record') ? (
          <button type="button" className="btn btn-ghost" onClick={reRecord}>
            Record again
          </button>
        ) : null}

        {can('submit') ? (
          <button type="button" className="btn btn-primary" onClick={submit}>
            Use this recording
          </button>
        ) : null}

        {state === 'permission_denied' || state === 'idle' ? (
          <button type="button" className="btn btn-ghost" onClick={onFallbackToText}>
            Type instead
          </button>
        ) : null}
      </div>

      {state === 'recording' ? (
        <div className="level" role="presentation">
          <span style={{ width: `${level}%` }} />
        </div>
      ) : null}

      {previewUrl ? <audio controls src={previewUrl} preload="metadata" /> : null}

      <p className="note">
        Ragers protects identifying details in your audio before it is shared.
      </p>
    </div>
  );
};
