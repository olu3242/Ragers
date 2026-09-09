(() => {
  'use strict';

  const STORAGE_KEY = 'ragers.preview.v1';

  function actorId() {
    try {
      const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return state.user?.id || null;
    } catch { return null; }
  }

  document.addEventListener('submit', (event) => {
    if (event.target?.id !== 'composerForm') return;

    const form = event.target;
    const actor = actorId();
    const body = form.querySelector('#bodyInput')?.value.trim();
    const postType = form.querySelector('input[name="postType"]:checked')?.value;
    const topicId = form.querySelector('#categoryInput')?.value || 'General';
    if (!actor || !body || !postType) return;

    const payload = {
      actorId: actor,
      type: postType === 'rager' ? 'rage' : 'rave',
      source: 'text',
      text: body,
      topicId,
      submittedAt: new Date().toISOString(),
      metadata: { client: 'web-preview' }
    };

    queueMicrotask(async () => {
      try {
        const response = await fetch('/api/experiences', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`integrity_api_${response.status}`);
        const result = await response.json();
        window.dispatchEvent(new CustomEvent('ragers:integrity-published', { detail: result.publicSummary }));
      } catch (error) {
        console.warn('Ragers integrity runtime unavailable; local preview post remains intact.', error.message);
      }
    });
  }, true);

  window.addEventListener('ragers:integrity-published', (event) => {
    const toast = document.querySelector('#toast');
    if (!toast || !event.detail) return;
    const band = String(event.detail.confidenceBand || 'unverified').replace(/_/g, ' ');
    toast.textContent = `Published · integrity signal: ${band}`;
    toast.hidden = false;
    window.setTimeout(() => { toast.hidden = true; }, 2800);
  });
})();
