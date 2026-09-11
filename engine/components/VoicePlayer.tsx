'use client';

import { useState } from 'react';

/**
 * Playback fetches a short-lived grant on demand. The grant references only the
 * protected derivative, so no original media key ever reaches the browser.
 */
export const VoicePlayer = ({ mediaAssetId }: { mediaAssetId: string }) => {
  const [source, setSource] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/voice/playback?mediaAssetId=${encodeURIComponent(mediaAssetId)}`);
      if (!response.ok) {
        setError('That audio is not available right now.');
        return;
      }
      const body = (await response.json()) as { protectedKey: string };
      setSource(`/media/${body.protectedKey}`);
    } catch {
      setError('That audio could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  if (error) return <p className="note">{error}</p>;

  if (!source) {
    return (
      <button type="button" className="btn btn-ghost" onClick={load} disabled={loading}>
        {loading ? 'Loading…' : 'Play voice note'}
      </button>
    );
  }

  return <audio controls src={source} preload="none" />;
};
