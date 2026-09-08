(() => {
  'use strict';

  const STORAGE_KEY = 'ragers.preview.v1';
  const seedPosts = [
    {id:'seed-1',type:'rager',body:'Speakerphone call on full volume for the entire train ride. Headphones exist.',category:'Driving & transit',visibility:'alias',display:'SkyLaneSam',createdAt:'2026-09-08T15:00:00.000Z',seed:true},
    {id:'seed-2',type:'rave',body:'A stranger ran back to return a wallet that fell out of someone’s bag.',category:'Everyday courtesy',visibility:'anonymous',display:'Anonymous',createdAt:'2026-09-08T15:30:00.000Z',seed:true}
  ];

  const $ = (selector, root=document) => root.querySelector(selector);
  const $$ = (selector, root=document) => Array.from(root.querySelectorAll(selector));

  const state = loadState();
  let currentView = 'feed';
  let currentFilter = 'all';

  function freshState() { return {user:null, signedIn:false, aliases:[], posts:[]}; }
  function loadState() {
    try { return {...freshState(), ...(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {})}; }
    catch { return freshState(); }
  }
  function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function uid(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function showToast(message) {
    const toast = $('#toast'); toast.textContent = message; toast.hidden = false;
    window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 2400);
  }

  function setSignedInUI() {
    const signedIn = Boolean(state.user && state.signedIn);
    $('#authView').hidden = signedIn;
    $('#productView').hidden = !signedIn;
    $('#signOutBtn').hidden = !signedIn;
    if (!signedIn) return;
    $('#sidebarGreeting').textContent = `Hi, ${state.user.name}`;
    $('#profileName').textContent = state.user.name;
    renderAliases(); renderFeed(); renderProfile(); setView(currentView);
  }

  function setView(view) {
    if (!state.user) return;
    currentView = view;
    $$('.app-view').forEach(panel => { panel.hidden = panel.dataset.viewPanel !== view; });
    if (view === 'feed') renderFeed();
    if (view === 'profile') renderProfile();
    if (view === 'settings') renderAliases();
    window.scrollTo({top:0, behavior:'smooth'});
  }

  function currentIdentity(visibility, aliasId) {
    if (visibility === 'anonymous') return 'Anonymous';
    if (visibility === 'alias') return state.aliases.find(a => a.id === aliasId)?.name || 'Alias';
    return state.user?.name || 'Public';
  }

  function renderFeed() {
    const list = $('#feedList');
    const posts = [...state.posts, ...seedPosts]
      .filter(p => currentFilter === 'all' || p.type === currentFilter)
      .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    list.innerHTML = posts.map(renderPostCard).join('');
    $('#emptyFeed').hidden = posts.length > 0;
  }

  function renderPostCard(post, ownOnly=false) {
    const isOwn = !post.seed && state.user && post.userId === state.user.id;
    const typeLabel = post.type === 'rager' ? '🔥 Rager' : '🙌 Rave';
    return `<article class="feed-card ${post.type}" data-post-id="${escapeHtml(post.id)}">
      <div class="feed-card-head"><span class="feed-card-type">${typeLabel}</span><span class="feed-card-meta">${escapeHtml(post.display)} · ${escapeHtml(post.category)}</span></div>
      <p class="feed-card-body">${escapeHtml(post.body)}</p>
      <div class="feed-card-foot"><span>${post.type === 'rager' ? 'Fair Rager?' : 'Worth raving about'}</span>${isOwn || ownOnly ? `<button class="delete-post" data-delete-post="${escapeHtml(post.id)}">Delete</button>` : ''}</div>
    </article>`;
  }

  function renderProfile() {
    if (!state.user) return;
    const own = state.posts.filter(p => p.userId === state.user.id).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    $('#profilePostCount').textContent = own.length;
    $('#profileAliasCount').textContent = state.aliases.length;
    $('#profilePosts').innerHTML = own.length ? own.map(p => renderPostCard(p,true)).join('') : '<div class="empty-state"><h2>No posts yet.</h2><p>Your Ragers and Raves will appear here.</p></div>';
  }

  function renderAliases() {
    const select = $('#aliasSelect');
    select.innerHTML = state.aliases.length ? state.aliases.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join('') : '<option value="">No alias yet</option>';
    $('#aliasList').innerHTML = state.aliases.length ? state.aliases.map(a => `<li><span>@${escapeHtml(a.name)}</span><span>Active</span></li>`).join('') : '<li><span>No aliases yet</span></li>';
    $('#profileAliasCount').textContent = state.aliases.length;
  }

  function updateComposerType(type) {
    const radio = $(`input[name="postType"][value="${type}"]`); if (radio) radio.checked = true;
    $('#composerTitle').textContent = type === 'rager' ? 'Rager it' : 'Rave it';
    $('#publishBtn').textContent = type === 'rager' ? 'Publish Rager' : 'Publish Rave';
  }

  function updateVisibility() {
    const visibility = $('input[name="visibility"]:checked')?.value || 'public';
    $('#aliasField').hidden = visibility !== 'alias';
    $('#identitySummary').textContent = visibility[0].toUpperCase() + visibility.slice(1);
  }

  $('#authForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const email = $('#emailInput').value.trim(); const name = $('#nameInput').value.trim();
    if (!state.user || state.user.email.toLowerCase() !== email.toLowerCase()) {
      state.user = {id:uid('usr'), email, name, createdAt:new Date().toISOString()};
    } else {
      state.user.name = name;
    }
    state.signedIn = true;
    saveState(); setSignedInUI(); showToast('Preview account created.');
  });

  $('#signOutBtn').addEventListener('click', () => {
    state.signedIn = false; saveState(); setSignedInUI(); showToast('Signed out of preview.');
  });

  $$('[data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('[data-create-type]').forEach(button => button.addEventListener('click', () => { updateComposerType(button.dataset.createType); setView('create'); }));
  $$('input[name="postType"]').forEach(radio => radio.addEventListener('change', () => updateComposerType(radio.value)));
  $$('input[name="visibility"]').forEach(radio => radio.addEventListener('change', updateVisibility));
  $('#bodyInput').addEventListener('input', () => { $('#charCount').textContent = $('#bodyInput').value.length; });

  $$('.filter-chip').forEach(button => button.addEventListener('click', () => {
    currentFilter = button.dataset.filter;
    $$('.filter-chip').forEach(b => b.classList.toggle('active', b === button));
    renderFeed();
  }));

  $('#composerForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const body = $('#bodyInput').value.trim(); if (!body) return;
    const type = $('input[name="postType"]:checked').value;
    const visibility = $('input[name="visibility"]:checked').value;
    const aliasId = visibility === 'alias' ? $('#aliasSelect').value : null;
    if (visibility === 'alias' && !aliasId) { showToast('Add an alias before posting with one.'); setView('settings'); return; }
    const post = {id:uid('post'), userId:state.user.id, type, body, category:$('#categoryInput').value, visibility, aliasId, display:currentIdentity(visibility,aliasId), createdAt:new Date().toISOString()};
    state.posts.push(post); saveState();
    event.target.reset(); $('#charCount').textContent = '0'; updateComposerType('rager'); updateVisibility();
    renderFeed(); renderProfile(); setView('feed'); showToast(type === 'rager' ? 'Rager published.' : 'Rave published.');
  });

  $('#aliasForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = $('#aliasInput').value.trim().replace(/^@/,''); if (!name) return;
    if (state.aliases.some(a => a.name.toLowerCase() === name.toLowerCase())) { showToast('That alias already exists in this preview.'); return; }
    state.aliases.push({id:uid('alias'), userId:state.user.id, name, createdAt:new Date().toISOString()}); saveState();
    $('#aliasInput').value=''; renderAliases(); showToast(`@${name} added.`);
  });

  $('#newAliasBtn').addEventListener('click', () => setView('settings'));

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete-post]'); if (!button) return;
    const id = button.dataset.deletePost; const index = state.posts.findIndex(p => p.id === id && p.userId === state.user?.id);
    if (index < 0) return; state.posts.splice(index,1); saveState(); renderFeed(); renderProfile(); showToast('Post deleted.');
  });

  $('#clearAccountBtn').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY); Object.assign(state, freshState()); currentView='feed'; setSignedInUI(); showToast('Preview account cleared.');
  });

  const requestedView = window.location.hash.replace('#','');
  if (['feed','create','profile','settings'].includes(requestedView)) currentView = requestedView;
  window.addEventListener('hashchange', () => {
    const next = window.location.hash.replace('#','');
    if (state.user && state.signedIn && ['feed','create','profile','settings'].includes(next)) setView(next);
  });
  setSignedInUI(); updateVisibility();
})();
