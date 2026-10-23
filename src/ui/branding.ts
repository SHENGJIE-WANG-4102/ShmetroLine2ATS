import { LINE } from '../data/current';
import { h } from './dom';

/** A fictional or newly added line may have no image asset yet. */
export function lineBadge(className = ''): HTMLElement {
  const label = `${LINE.branding.shortName} ${LINE.ui.lineNameEn}`;
  return LINE.branding.badgeUrl
    ? h('img', { class: className, src: LINE.branding.badgeUrl, alt: label })
    : h('span', { class: `${className} line-badge-text`, title: label }, LINE.branding.logoText);
}
