'use strict';
(async function () {
  const root = document.getElementById('portal');
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (date) => (date ? date.split('-').reverse().join('/') : '');
  const LEVEL = { atrasado: 'Atrasado', hoje: 'Vence hoje', proximo: 'Prazo próximo' };

  function row(item) {
    return `<li class="row">
      <div class="row-main">
        <strong>${esc(item.title)}</strong>
        ${item.details ? `<p class="muted">${esc(item.details)}</p>` : ''}
      </div>
      <div class="row-side">
        ${item.level ? `<span class="tag ${item.level}">${LEVEL[item.level]}</span>` : ''}
        ${item.due_date ? `<span class="muted">até ${fmt(item.due_date)}</span>` : ''}
      </div>
    </li>`;
  }

  try {
    const token = location.pathname.split('/').pop();
    const response = await fetch(`/api/portal/${encodeURIComponent(token)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    const documents = data.pending.filter((item) => item.kind === 'documento');
    const others = data.pending.filter((item) => item.kind !== 'documento');
    root.innerHTML = `
      <header class="portal-head">
        <p class="muted">Acompanhamento</p>
        <h1>${esc(data.client.name)}</h1>
      </header>
      <section class="card">
        <h2>Documentos que precisamos</h2>
        ${documents.length ? `<ul class="list">${documents.map(row).join('')}</ul>`
          : '<p class="muted">Nenhum documento pendente.</p>'}
      </section>
      <section class="card">
        <h2>Próximos prazos</h2>
        ${others.length ? `<ul class="list">${others.map(row).join('')}</ul>`
          : '<p class="muted">Nenhum prazo em aberto.</p>'}
      </section>
      ${data.completed.length ? `<section class="card">
        <h2>Concluídos</h2>
        <ul class="list">${data.completed.map((item) => `<li class="row"><span>${esc(item.title)}</span>
          <span class="muted">${fmt(item.done_at)}</span></li>`).join('')}</ul>
      </section>` : ''}`;
  } catch (error) {
    root.innerHTML = `<section class="card"><h1>Página indisponível</h1>
      <p class="muted">${esc(error.message)}</p></section>`;
  }
})();
