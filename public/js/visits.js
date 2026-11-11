// Visit reports: rendered the same way on the client dashboard and in admin.

import { esc, fmtDate } from './common.js';

/** One visit report. */
export function visitHtml(v, propertyId, { admin = false } = {}) {
  const done = v.tasks.filter((t) => t.done).length;
  return `<article class="visit">
    <div class="visit-head">
      <h3>${esc(fmtDate(v.date))}</h3>
      <span class="visit-meta">${[v.minutes ? `${v.minutes} min on site` : '', v.crew ? `Crew: ${esc(v.crew)}` : '', `${done} of ${v.tasks.length} tasks completed`].filter(Boolean).join(' · ')}</span>
    </div>
    <ul class="checks">${v.tasks.map((t) => `<li class="${t.done ? '' : 'skip'}">${esc(t.label)}${t.done ? '' : '<span class="why">Not done this visit' + (t.note ? ` — ${esc(t.note)}` : '') + '</span>'}${t.done && t.note ? `<span class="why">${esc(t.note)}</span>` : ''}</li>`).join('')}</ul>
    ${v.notes ? `<div class="note"><strong>Note from your crew:</strong> ${esc(v.notes)}</div>` : ''}
    ${v.photos?.length ? `<div class="photos">${v.photos.map((ph) => `<figure data-full="/api/photos/${propertyId}/${ph.id}"><img loading="lazy" src="/api/photos/${propertyId}/${ph.id}" alt="${esc(ph.tag || 'Visit')} photo from ${esc(fmtDate(v.date))}">${ph.tag ? `<figcaption>${esc(ph.tag)}</figcaption>` : ''}</figure>`).join('')}</div>` : ''}
    ${admin ? `<p style="margin:12px 0 0"><button class="btn danger small" data-delete-visit="${v.id}">Delete this report</button></p>` : ''}
  </article>`;
}

export function lightbox(e) {
  const fig = e.target.closest('figure[data-full]');
  if (!fig) return;
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<img src="${fig.dataset.full}" alt="">`;
  box.addEventListener('click', () => box.remove());
  document.body.append(box);
}
