'use client';

import { useState } from 'react';
import { VoiceRecorder, type RecordingResult } from './VoiceRecorder.tsx';
import { BODY_MAX_LENGTH, type CreationMode, type ExperienceKind, type Visibility } from '../src/domain/types.ts';

type Stage = 'composing' | 'submitting' | 'protecting' | 'done';

/**
 * The composer. Text and voice are two modes of the same form, because they are
 * two creation modes of one aggregate — switching mode never discards what the
 * author has already written.
 */
export const Composer = ({ categories }: { categories: readonly string[] }) => {
  const [kind, setKind] = useState<ExperienceKind>('rage');
  const [mode, setMode] = useState<CreationMode>('text');
  const [category, setCategory] = useState(categories[0] ?? 'Other');
  const [bodyText, setBodyText] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [recording, setRecording] = useState<RecordingResult | undefined>(undefined);
  const [stage, setStage] = useState<Stage>('composing');
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async (): Promise<void> => {
    setError(undefined);
    setStage('submitting');
    try {
      const created = await fetch('/api/experiences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, creationMode: mode, category, bodyText, visibility }),
      });
      if (!created.ok) {
        const body = (await created.json()) as { error?: { message?: string } };
        setError(body.error?.message ?? 'That could not be posted.');
        setStage('composing');
        return;
      }
      const { experienceId, awaitingMedia } = (await created.json()) as {
        experienceId: string;
        awaitingMedia: boolean;
      };

      if (!awaitingMedia || !recording) {
        setStage('done');
        return;
      }

      // Voice mode: request a single-use target, upload, then attach.
      setStage('protecting');
      const target = await fetch('/api/voice/upload-target', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ experienceId }),
      });
      if (!target.ok) {
        setError('Your recording could not be uploaded.');
        setStage('composing');
        return;
      }
      const { uploadTargetId } = (await target.json()) as { uploadTargetId: string };

      const attached = await fetch('/api/voice/attach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          experienceId,
          uploadTargetId,
          durationMs: recording.durationMs,
          byteSize: recording.blob.size,
          mimeType: recording.mimeType,
        }),
      });
      if (!attached.ok) {
        const body = (await attached.json()) as { error?: { message?: string } };
        setError(body.error?.message ?? 'That recording could not be used.');
        setStage('composing');
        return;
      }
      setStage('done');
    } catch {
      setError('Something went wrong. Try again.');
      setStage('composing');
    }
  };

  if (stage === 'done') {
    return (
      <div className="card">
        <h2>Posted</h2>
        <p className="note">
          {mode === 'voice'
            ? 'We are protecting identifying details in your audio. It will appear once that is done.'
            : 'Your moment is live.'}
        </p>
        <div className="actions">
          <a className="btn btn-primary" href="/">
            Back to Explore
          </a>
        </div>
      </div>
    );
  }

  const canSubmit =
    stage === 'composing' && (mode === 'text' ? bodyText.trim().length > 0 : recording !== undefined);

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <fieldset>
        <legend>What kind of moment is this?</legend>
        <div className="choices">
          {(['rage', 'rave'] as const).map((option) => (
            <label className="choice" key={option}>
              <input
                type="radio"
                name="kind"
                value={option}
                checked={kind === option}
                onChange={() => setKind(option)}
              />
              <span>
                <strong>{option === 'rage' ? 'Rager' : 'Rave'}</strong>
                <small>
                  {option === 'rage' ? 'Something should happen less' : 'Something should happen more'}
                </small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>How do you want to say it?</legend>
        <div className="choices">
          {(['text', 'voice'] as const).map((option) => (
            <label className="choice" key={option}>
              <input
                type="radio"
                name="mode"
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
              />
              <span>
                <strong>{option === 'text' ? 'Write it' : 'Say it'}</strong>
                <small>{option === 'text' ? 'Type a short note' : 'Record a voice note'}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {mode === 'voice' ? (
        recording ? (
          <div className="recorder">
            <p>Recording attached · {Math.round(recording.durationMs / 1000)}s</p>
            <button type="button" className="btn btn-ghost" onClick={() => setRecording(undefined)}>
              Record again
            </button>
          </div>
        ) : (
          <VoiceRecorder onReady={setRecording} onFallbackToText={() => setMode('text')} />
        )
      ) : null}

      <div style={{ marginTop: 18 }}>
        <label htmlFor="body">
          {mode === 'voice' ? 'Add a note (optional)' : 'What happened?'}
        </label>
        <textarea
          id="body"
          name="body"
          maxLength={BODY_MAX_LENGTH}
          value={bodyText}
          placeholder="Describe the behavior, not the person."
          onChange={(event) => setBodyText(event.target.value)}
        />
        <p className="char-count">
          {bodyText.length}/{BODY_MAX_LENGTH}
        </p>
      </div>

      <div style={{ marginBottom: 18 }}>
        <label htmlFor="category">Category</label>
        <select
          id="category"
          name="category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          {categories.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      <fieldset>
        <legend>How do you want to show up?</legend>
        <div className="choices">
          {(
            [
              ['public', 'Public', 'Show your display name'],
              ['alias', 'Alias', 'Use a reusable nickname'],
              ['anonymous', 'Anonymous', 'No profile attached'],
            ] as const
          ).map(([value, title, hint]) => (
            <label className="choice" key={value}>
              <input
                type="radio"
                name="visibility"
                value={value}
                checked={visibility === value}
                onChange={() => setVisibility(value)}
              />
              <span>
                <strong>{title}</strong>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {error ? <p className="error">{error}</p> : null}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          {stage === 'submitting'
            ? 'Posting…'
            : stage === 'protecting'
              ? 'Protecting your audio…'
              : kind === 'rage'
                ? 'Publish Rager'
                : 'Publish Rave'}
        </button>
        <a className="btn btn-ghost" href="/">
          Cancel
        </a>
      </div>
    </form>
  );
};
