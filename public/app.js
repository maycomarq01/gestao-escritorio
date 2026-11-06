'use strict';

const TYPES = {
  obra: 'Obra', projeto: 'Projeto', regularizacao: 'Regularização', contabil_juridico: 'Contábil/Jurídico',
};
const LEVEL = { atrasado: 'Atrasado', hoje: 'Vence hoje', proximo: 'Prazo próximo' };
const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

const app = document.getElementById('app');
const dialog = document.getElementById('dialog');
const toastEl = document.getElementById('toast');

let S = null; // dados vindos do servidor
const ui = { scope: 'meus', showSeen: false, search: '', type: '', meetingType: '', drafts: {} };
let onDialogSubmit = null;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (date) => (date ? date.split('-').reverse().join('/') : '');
const clientOf = (id) => S.clients.find((c) => c.id === id);
const userOf = (id) => S.users.find((u) => u.id === id);

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Não foi possível concluir.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastEl.hidden = true; }, 3000);
}

async function refresh() {
  try {
    S = await api('GET', '/api/bootstrap');
    render();
  } catch (error) {
    if (error.status === 401) return start();
    toast(error.message);
  }
}

async function act(method, url, body, message) {
  try {
    const result = await api(method, url, body);
    if (message) toast(message);
    await refresh();
    return result;
  } catch (error) {
    if (error.status === 401) start(); else toast(error.message);
    return null;
  }
}

// ---------- entrada ----------
async function start() {
  const status = await api('GET', '/api/status');
  if (status.me) return refresh();
  S = null;
  const setup = status.needsSetup;
  app.innerHTML = `<div class="auth"><form data-auth="${setup ? 'setup' : 'login'}">
    <h1>${setup ? 'Primeiro acesso' : 'Gestão do escritório'}</h1>
    <p class="muted">${setup ? 'Crie o usuário administrador.' : 'Entre com seu login.'}</p>
    ${setup ? '<label class="field">Seu nome<input name="name" required autocomplete="name"></label>' : ''}
    <label class="field">Login<input name="login" required autocapitalize="none" autocomplete="username"></label>
    <label class="field">Senha<input name="password" type="password" required minlength="${setup ? 8 : 1}"
      autocomplete="${setup ? 'new-password' : 'current-password'}"></label>
    <div class="error" data-error hidden></div>
    <button class="primary" type="submit">${setup ? 'Criar e entrar' : 'Entrar'}</button>
  </form></div>`;
}

// ---------- estrutura ----------
function alerts() {
  return S.items.filter((item) => item.level);
}
function myAlerts() {
  return alerts().filter((item) => item.owner_id === S.me.id || item.owner_id === null);
}
function nextReview() {
  const now = new Date(`${S.today}T12:00:00Z`);
  const diff = (S.settings.review_weekday - now.getUTCDay() + 7) % 7;
  const date = new Date(now.getTime() + diff * 86400000).toISOString().slice(0, 10);
  return { date, isToday: diff === 0 };
}
function nextMeeting() {
  return S.meetings.map((m) => m.next_date).filter((d) => d && d >= S.today).sort()[0] || null;
}

function render() {
  if (!S) return;
  const route = location.hash.slice(1) || 'painel';
  const [page, id] = route.split('/');
  const unseen = myAlerts().filter((item) => !item.seen).length;
  const views = { painel: viewPanel, clientes: viewClients, cliente: () => viewClient(Number(id)),
    reuniao: viewMeeting, equipe: viewTeam };
  const view = views[page] || viewPanel;
  const nav = (target, label, badge) => {
    const active = page === target || (page === 'cliente' && target === 'clientes');
    return `<a class="nav-link ${active ? 'active' : ''}" href="#${target}"><span>${label}</span>${
      badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
  };
  app.innerHTML = `<div class="layout">
    <nav class="side">
      <div class="brand">Escritório</div>
      ${nav('painel', 'Avisos', unseen)}${nav('clientes', 'Clientes')}${nav('reuniao', 'Reunião')}${nav('equipe', 'Equipe')}
    </nav>
    <main class="content">${view()}</main>
  </div>`;
}

function itemRow(item, { showClient = true, inlineDate = false, seenAction = false } = {}) {
  const owner = userOf(item.owner_id);
  const client = clientOf(item.client_id);
  const days = item.days_left;
  const when = item.level === 'atrasado' ? `${-days} dia(s) de atraso`
    : item.level === 'proximo' ? `faltam ${days} dia(s)` : '';
  return `<li class="row ${item.done ? 'done' : ''}">
    <input class="row-check" type="checkbox" data-change="toggle-done" data-id="${item.id}"
      ${item.done ? 'checked' : ''} aria-label="Concluir ${esc(item.title)}">
    <div class="row-main">
      <strong>${esc(item.title)}</strong>
      <div class="muted">${showClient ? `<a href="#cliente/${item.client_id}">${esc(client?.name)}</a> · ` : ''}${
        item.kind === 'documento' ? 'Documento' : 'Atividade'}${owner ? ` · ${esc(owner.name)}` : ' · sem responsável'}${
        item.visible_to_client ? ' · visível ao cliente' : ''}</div>
      ${item.details ? `<div class="muted">${esc(item.details)}</div>` : ''}
    </div>
    <div class="row-side">
      ${item.level ? `<span class="tag ${item.level}">${LEVEL[item.level]}</span>` : ''}
      ${when ? `<span class="muted">${when}</span>` : ''}
      ${inlineDate
        ? `<input class="inline-date" type="date" value="${esc(item.due_date)}" data-change="set-date"
            data-id="${item.id}" aria-label="Prazo de ${esc(item.title)}">`
        : item.due_date ? `<span class="muted">${fmt(item.due_date)}</span>` : ''}
      ${seenAction && !item.seen ? `<button class="small" data-act="seen" data-id="${item.id}">Visto</button>` : ''}
      <button class="small" data-act="edit-item" data-id="${item.id}">Editar</button>
    </div>
  </li>`;
}

function section(title, items, options) {
  if (!items.length) return '';
  return `<section class="card"><h2>${title} (${items.length})</h2>
    <ul class="list">${items.map((item) => itemRow(item, options)).join('')}</ul></section>`;
}

// ---------- avisos ----------
function viewPanel() {
  const review = nextReview();
  const meeting = nextMeeting();
  let list = ui.scope === 'meus' ? myAlerts() : alerts();
  const hiddenSeen = ui.showSeen ? 0 : list.filter((item) => item.seen).length;
  if (!ui.showSeen) list = list.filter((item) => !item.seen);
  const openDocs = S.items.filter((item) => !item.done && item.kind === 'documento');
  const undatedDocs = openDocs.filter((item) => !item.due_date);
  const late = alerts().filter((item) => item.level === 'atrasado').length;
  const dueToday = alerts().filter((item) => item.level === 'hoje').length;
  const option = { seenAction: true };
  return `
    <div class="page-head"><h1>Avisos</h1>
      <div class="actions">
        <div class="segment">
          <button class="${ui.scope === 'meus' ? 'on' : ''}" data-act="scope" data-value="meus">Meus</button>
          <button class="${ui.scope === 'todos' ? 'on' : ''}" data-act="scope" data-value="todos">Todos</button>
        </div>
        <button class="primary" data-act="new-item">Novo item</button>
      </div>
    </div>
    <div class="banner ${review.isToday ? 'today' : ''}">
      ${review.isToday ? 'Hoje é dia de revisar os avisos.' : `Próxima revisão de avisos: ${WEEKDAYS[S.settings.review_weekday]}, ${fmt(review.date)}.`}
      ${meeting ? ` Próxima reunião: ${fmt(meeting)}.` : ''}
    </div>
    <div class="stats">
      <div class="stat ${late ? 'alert' : ''}"><b>${late}</b><span class="muted">Atrasados</span></div>
      <div class="stat"><b>${dueToday}</b><span class="muted">Vencem hoje</span></div>
      <div class="stat"><b>${alerts().length - late - dueToday}</b><span class="muted">Prazo próximo</span></div>
      <div class="stat"><b>${openDocs.length}</b><span class="muted">Documentos faltando</span></div>
    </div>
    ${section('Atrasados', list.filter((item) => item.level === 'atrasado'), option)}
    ${section('Vencem hoje', list.filter((item) => item.level === 'hoje'), option)}
    ${section('Prazo próximo', list.filter((item) => item.level === 'proximo'), option)}
    ${!list.length ? '<section class="card"><p class="empty">Nenhum aviso pendente.</p></section>' : ''}
    ${section('Documentos faltando sem prazo', undatedDocs, {})}
    ${hiddenSeen || ui.showSeen ? `<button class="link" data-act="toggle-seen">${
      ui.showSeen ? 'Ocultar vistos' : `Mostrar ${hiddenSeen} já visto(s)`}</button>` : ''}`;
}

// ---------- clientes ----------
function viewClients() {
  const search = ui.search.toLowerCase();
  const list = S.clients.filter((c) => (!ui.type || c.type === ui.type)
    && (!search || c.name.toLowerCase().includes(search)));
  const cards = list.map((c) => {
    const open = S.items.filter((item) => item.client_id === c.id && !item.done);
    const docs = open.filter((item) => item.kind === 'documento').length;
    const alertsCount = open.filter((item) => item.level).length;
    return `<a class="client-card ${c.active ? '' : 'inactive'}" href="#cliente/${c.id}">
      <strong>${esc(c.name)}</strong>
      <div class="client-meta">
        <span class="tag">${TYPES[c.type]}</span>
        ${c.active ? '' : '<span class="tag">Inativo</span>'}
        ${alertsCount ? `<span class="tag atrasado">${alertsCount} aviso(s)</span>` : ''}
        ${docs ? `<span class="tag hoje">${docs} doc. faltando</span>` : ''}
        <span class="muted">${open.length} em aberto</span>
      </div>
    </a>`;
  }).join('');
  return `
    <div class="page-head"><h1>Clientes</h1>
      <button class="primary" data-act="new-client">Novo cliente</button></div>
    <div class="filters">
      <input type="search" placeholder="Buscar cliente" value="${esc(ui.search)}" data-input="search" aria-label="Buscar cliente">
      <select data-change="filter-type" aria-label="Tipo de cliente">
        <option value="">Todos os tipos</option>
        ${Object.entries(TYPES).map(([key, label]) => `<option value="${key}" ${ui.type === key ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    ${cards ? `<div class="client-grid">${cards}</div>`
      : `<section class="card"><p class="empty">${S.clients.length ? 'Nenhum cliente encontrado.' : 'Cadastre o primeiro cliente.'}</p></section>`}`;
}

function viewClient(id) {
  const c = clientOf(id);
  if (!c) return '<section class="card"><p class="empty">Cliente não encontrado.</p></section>';
  const items = S.items.filter((item) => item.client_id === id);
  const open = items.filter((item) => !item.done);
  const notes = S.notes.filter((note) => note.client_id === id);
  const portal = `${location.origin}/c/${c.portal_token}`;
  const options = { showClient: false, inlineDate: true };
  return `
    <div class="page-head">
      <div><h1>${esc(c.name)}</h1>
        <p class="muted">${TYPES[c.type]}${c.phone ? ` · ${esc(c.phone)}` : ''}${c.email ? ` · ${esc(c.email)}` : ''}${c.active ? '' : ' · Inativo'}</p>
      </div>
      <div class="actions">
        <button class="primary" data-act="new-item" data-client="${id}">Novo item</button>
        <button data-act="edit-client" data-id="${id}">Editar</button>
      </div>
    </div>
    ${c.notes ? `<section class="card"><p class="note">${esc(c.notes)}</p></section>` : ''}
    ${section('Documentos faltando', open.filter((item) => item.kind === 'documento'), options)}
    ${section('Atividades em aberto', open.filter((item) => item.kind !== 'documento'), options)}
    ${!open.length ? '<section class="card"><p class="empty">Nada em aberto para este cliente.</p></section>' : ''}
    <section class="card"><h2>Página do cliente</h2>
      <p class="muted">Quem tiver este link vê os itens marcados como visíveis ao cliente, sem precisar de senha.</p>
      <div class="link-box section-gap">
        <input readonly value="${esc(portal)}" aria-label="Link do cliente">
        <button data-act="copy-link" data-value="${esc(portal)}">Copiar</button>
      </div>
      <button class="link section-gap" data-act="new-link" data-id="${id}">Trocar o link (o atual para de funcionar)</button>
    </section>
    <section class="card"><h2>Anotações</h2>
      ${notes.length ? notes.map((note) => `<div class="note"><span class="muted">${fmt(note.date)} · ${esc(note.author)}</span><br>${esc(note.text)}</div>`).join('')
        : '<p class="empty">Nenhuma anotação ainda.</p>'}
    </section>
    ${section('Concluídos', items.filter((item) => item.done), { showClient: false })}`;
}

// ---------- reunião ----------
function viewMeeting() {
  const current = S.meetings.find((m) => !m.closed);
  if (!current) {
    const past = S.meetings.filter((m) => m.closed);
    return `
      <div class="page-head"><h1>Reunião</h1>
        <button class="primary" data-act="start-meeting">Iniciar reunião de hoje</button></div>
      <section class="card"><h2>Reuniões anteriores</h2>
        ${past.length ? past.map((m) => `<div class="note"><strong>${fmt(m.date)}</strong>${
          m.next_date ? ` <span class="muted">· próxima: ${fmt(m.next_date)}</span>` : ''}<br>${esc(m.summary) || '<span class="muted">Sem resumo.</span>'}</div>`).join('')
          : '<p class="empty">Nenhuma reunião registrada.</p>'}
      </section>`;
  }
  const clients = S.clients.filter((c) => c.active && (!ui.meetingType || c.type === ui.meetingType));
  const cards = clients.map((c) => {
    const open = S.items.filter((item) => item.client_id === c.id && !item.done);
    return `<section class="card">
      <div class="page-head"><div><h2><a href="#cliente/${c.id}">${esc(c.name)}</a></h2>
        <span class="tag">${TYPES[c.type]}</span></div>
        <button class="small" data-act="new-item" data-client="${c.id}">Novo item</button></div>
      ${open.length ? `<ul class="list">${open.map((item) => itemRow(item, { showClient: false, inlineDate: true })).join('')}</ul>`
        : '<p class="empty">Nada em aberto.</p>'}
      <label class="field section-gap">Anotação da reunião
        <textarea data-input="note-${c.id}">${esc(ui.drafts[`note-${c.id}`])}</textarea></label>
      <button class="small" data-act="save-note" data-id="${c.id}">Salvar anotação</button>
    </section>`;
  }).join('');
  return `
    <div class="page-head"><h1>Reunião de ${fmt(current.date)}</h1></div>
    <div class="filters">
      <select data-change="meeting-type" aria-label="Tipo de cliente">
        <option value="">Todos os tipos</option>
        ${Object.entries(TYPES).map(([key, label]) => `<option value="${key}" ${ui.meetingType === key ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    ${cards || '<section class="card"><p class="empty">Nenhum cliente ativo.</p></section>'}
    <section class="card"><h2>Encerrar reunião</h2>
      <label class="field">Resumo
        <textarea data-input="summary">${esc(ui.drafts.summary ?? current.summary)}</textarea></label>
      <label class="field">Próxima reunião
        <input type="date" data-input="next" value="${esc(ui.drafts.next ?? current.next_date)}"></label>
      <button class="primary" data-act="close-meeting" data-id="${current.id}">Encerrar reunião</button>
    </section>`;
}

// ---------- equipe ----------
function viewTeam() {
  const admin = S.me.role === 'admin';
  return `
    <div class="page-head"><h1>Equipe</h1>
      <div class="actions">
        ${admin ? '<button class="primary" data-act="new-user">Novo usuário</button>' : ''}
        <button data-act="logout">Sair</button>
      </div></div>
    <section class="card"><ul class="list">
      ${S.users.map((u) => `<li class="row">
        <div class="row-main"><strong>${esc(u.name)}</strong>
          <div class="muted">${esc(u.login)} · ${u.role === 'admin' ? 'Administrador' : 'Membro'}</div></div>
        ${admin ? `<div class="row-side">
          <button class="small" data-act="reset-password" data-id="${u.id}">Trocar senha</button>
          ${u.id !== S.me.id ? `<button class="small danger" data-act="delete-user" data-id="${u.id}">Remover</button>` : ''}
        </div>` : ''}
      </li>`).join('')}
    </ul></section>
    ${admin ? `<section class="card"><h2>Dia de revisar os avisos</h2>
      <label class="field">Toda semana, em
        <select data-change="review-day">
          ${WEEKDAYS.map((day, index) => `<option value="${index}" ${S.settings.review_weekday === index ? 'selected' : ''}>${day}</option>`).join('')}
        </select></label>
    </section>` : ''}`;
}

// ---------- janelas ----------
function openDialog(title, fields, submit, { extra = '' } = {}) {
  onDialogSubmit = submit;
  dialog.innerHTML = `<form data-dialog>
    <h2>${esc(title)}</h2>${fields}
    <div class="error" data-error hidden></div>
    <div class="dialog-actions">${extra}
      <button type="button" data-act="close-dialog">Cancelar</button>
      <button class="primary" type="submit">Salvar</button>
    </div></form>`;
  dialog.showModal();
}

function itemDialog(item) {
  const isNew = !item.id;
  const options = S.clients.filter((c) => c.active || c.id === item.client_id)
    .map((c) => `<option value="${c.id}" ${c.id === item.client_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  if (!options) return toast('Cadastre um cliente primeiro.');
  const kind = item.kind || 'atividade';
  openDialog(isNew ? 'Novo item' : 'Editar item', `
    <label class="field">Cliente<select name="client_id" required>${options}</select></label>
    <label class="field">Tipo<select name="kind">
      <option value="atividade" ${kind === 'atividade' ? 'selected' : ''}>Atividade ou prazo</option>
      <option value="documento" ${kind === 'documento' ? 'selected' : ''}>Documento faltando</option>
    </select></label>
    <label class="field">Título<input name="title" required maxlength="200" value="${esc(item.title)}"></label>
    <label class="field">Detalhes<textarea name="details">${esc(item.details)}</textarea></label>
    <div class="field-row">
      <label class="field">Prazo<input type="date" name="due_date" value="${esc(item.due_date)}"></label>
      <label class="field">Avisar (dias antes)<input type="number" name="notify_days" min="0" max="90" value="${item.notify_days ?? 3}"></label>
    </div>
    <label class="field">Responsável<select name="owner_id"><option value="">Sem responsável</option>
      ${S.users.map((u) => `<option value="${u.id}" ${u.id === (isNew ? S.me.id : item.owner_id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
    </select></label>
    <label class="field-inline"><input type="checkbox" name="visible_to_client" ${item.visible_to_client ? 'checked' : ''}>
      Mostrar na página do cliente</label>`,
  async (data) => {
    const body = { ...data, client_id: Number(data.client_id), owner_id: data.owner_id ? Number(data.owner_id) : null,
      notify_days: Number(data.notify_days), visible_to_client: !!data.visible_to_client };
    await api(isNew ? 'POST' : 'PUT', isNew ? '/api/items' : `/api/items/${item.id}`, body);
  }, { extra: isNew ? '' : `<button type="button" class="danger" data-act="delete-item" data-id="${item.id}">Excluir</button>` });
}

function clientDialog(client) {
  const isNew = !client.id;
  openDialog(isNew ? 'Novo cliente' : 'Editar cliente', `
    <label class="field">Nome<input name="name" required maxlength="200" value="${esc(client.name)}"></label>
    <label class="field">Tipo<select name="type">
      ${Object.entries(TYPES).map(([key, label]) => `<option value="${key}" ${client.type === key ? 'selected' : ''}>${label}</option>`).join('')}
    </select></label>
    <div class="field-row">
      <label class="field">Telefone<input name="phone" type="tel" value="${esc(client.phone)}"></label>
      <label class="field">E-mail<input name="email" type="email" value="${esc(client.email)}"></label>
    </div>
    <label class="field">Observações<textarea name="notes">${esc(client.notes)}</textarea></label>
    ${isNew ? '' : `<label class="field-inline"><input type="checkbox" name="active" ${client.active ? 'checked' : ''}>
      Cliente ativo (desmarcar desliga a página do cliente)</label>`}`,
  async (data) => {
    if (isNew) {
      const created = await api('POST', '/api/clients', data);
      location.hash = `cliente/${created.id}`;
    } else {
      await api('PUT', `/api/clients/${client.id}`, { ...data, active: !!data.active });
    }
  }, { extra: isNew ? '' : `<button type="button" class="danger" data-act="delete-client" data-id="${client.id}">Excluir</button>` });
}

// ---------- eventos ----------
const actions = {
  'close-dialog': () => dialog.close(),
  scope: ({ value }) => { ui.scope = value; render(); },
  'toggle-seen': () => { ui.showSeen = !ui.showSeen; render(); },
  'new-item': ({ client }) => itemDialog({ client_id: client ? Number(client) : undefined }),
  'edit-item': ({ id }) => itemDialog(S.items.find((item) => item.id === Number(id))),
  seen: ({ id }) => act('POST', `/api/items/${id}/seen`),
  'delete-item': async ({ id }) => {
    if (!confirm('Excluir este item?')) return;
    dialog.close();
    await act('DELETE', `/api/items/${id}`, undefined, 'Item excluído.');
  },
  'new-client': () => clientDialog({ type: 'obra' }),
  'edit-client': ({ id }) => clientDialog(clientOf(Number(id))),
  'delete-client': async ({ id }) => {
    if (!confirm('Excluir o cliente e todos os itens e anotações dele? Não dá para desfazer.')) return;
    dialog.close();
    location.hash = 'clientes';
    await act('DELETE', `/api/clients/${id}`, undefined, 'Cliente excluído.');
  },
  'copy-link': async ({ value }) => {
    try { await navigator.clipboard.writeText(value); toast('Link copiado.'); }
    catch { toast('Selecione o link e copie manualmente.'); }
  },
  'new-link': async ({ id }) => {
    if (confirm('Trocar o link? O link atual deixa de funcionar.')) {
      await act('POST', `/api/clients/${id}/new-link`, {}, 'Link trocado.');
    }
  },
  'start-meeting': () => act('POST', '/api/meetings', { date: S.today }),
  'save-note': async ({ id }) => {
    const key = `note-${id}`;
    const textValue = (ui.drafts[key] || '').trim();
    if (!textValue) return toast('Escreva a anotação primeiro.');
    const meeting = S.meetings.find((m) => !m.closed);
    const saved = await act('POST', '/api/notes', { client_id: Number(id), meeting_id: meeting?.id, text: textValue }, 'Anotação salva.');
    if (saved) { delete ui.drafts[key]; render(); }
  },
  'close-meeting': async ({ id }) => {
    const meeting = S.meetings.find((m) => m.id === Number(id));
    const saved = await act('PUT', `/api/meetings/${id}`, {
      summary: ui.drafts.summary ?? meeting.summary,
      next_date: ui.drafts.next ?? meeting.next_date,
      closed: true,
    }, 'Reunião encerrada.');
    if (saved) { delete ui.drafts.summary; delete ui.drafts.next; render(); }
  },
  'new-user': () => openDialog('Novo usuário', `
    <label class="field">Nome<input name="name" required></label>
    <label class="field">Login<input name="login" required autocapitalize="none" autocomplete="off"></label>
    <label class="field">Senha inicial<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
    <label class="field">Perfil<select name="role"><option value="membro">Membro</option><option value="admin">Administrador</option></select></label>`,
  (data) => api('POST', '/api/users', data)),
  'reset-password': ({ id }) => openDialog(`Trocar senha de ${userOf(Number(id)).name}`, `
    <label class="field">Nova senha<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>`,
  (data) => api('PUT', `/api/users/${id}/password`, data)),
  'delete-user': async ({ id }) => {
    if (confirm(`Remover ${userOf(Number(id)).name}? Os itens dessa pessoa ficam sem responsável.`)) {
      await act('DELETE', `/api/users/${id}`, undefined, 'Usuário removido.');
    }
  },
  logout: async () => { await api('POST', '/api/logout', {}); start(); },
};

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  if (target) actions[target.dataset.act]?.(target.dataset);
});

document.addEventListener('change', (event) => {
  const { change, id } = event.target.dataset;
  if (change === 'toggle-done') act('PUT', `/api/items/${id}`, { done: event.target.checked });
  if (change === 'set-date') act('PUT', `/api/items/${id}`, { due_date: event.target.value || null }, 'Prazo atualizado.');
  if (change === 'filter-type') { ui.type = event.target.value; render(); }
  if (change === 'meeting-type') { ui.meetingType = event.target.value; render(); }
  if (change === 'review-day') act('PUT', '/api/settings', { review_weekday: Number(event.target.value) }, 'Dia atualizado.');
});

document.addEventListener('input', (event) => {
  const key = event.target.dataset.input;
  if (!key) return;
  if (key === 'search') {
    ui.search = event.target.value;
    render();
    const input = document.querySelector('[data-input="search"]');
    input.focus();
    input.setSelectionRange(ui.search.length, ui.search.length);
  } else {
    ui.drafts[key] = event.target.value;
  }
});

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const errorEl = form.querySelector('[data-error]');
  const fail = (message) => { errorEl.textContent = message; errorEl.hidden = false; };
  try {
    if (form.dataset.auth) {
      await api('POST', form.dataset.auth === 'setup' ? '/api/setup' : '/api/login', data);
      await refresh();
    } else if ('dialog' in form.dataset) {
      await onDialogSubmit(data);
      dialog.close();
      await refresh();
    }
  } catch (error) {
    fail(error.message);
  }
});

window.addEventListener('hashchange', render);

// Mantém os dados da equipe atualizados sem atrapalhar quem está digitando.
setInterval(() => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (S && !dialog.open && !typing && !document.hidden) refresh();
}, 60000);

start().catch((error) => { app.textContent = error.message; });
