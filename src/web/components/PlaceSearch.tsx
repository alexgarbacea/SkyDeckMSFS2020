import { useEffect, useId, useRef, useState } from 'react';
import type { SearchResult } from '../../shared/types';
import { api } from '../lib/api';
import { Icon } from './ui';

const KIND_LABEL: Record<SearchResult['kind'], string> = { airport: 'Airport', navaid: 'Navaid', fix: 'Waypoint' };

export function describe(r: SearchResult): string {
  if (r.kind === 'airport') return [r.name, r.city, r.country].filter(Boolean).join(', ');
  if (r.kind === 'navaid') return `${r.name} ${r.type}${r.freqKhz ? `, ${r.type.startsWith('NDB') ? `${r.freqKhz} kHz` : `${(r.freqKhz / 1000).toFixed(2)} MHz`}` : ''}`;
  return r.name;
}

/** Search box for airports, navaids and waypoints with keyboard navigation. */
export function PlaceSearch({
  onPick,
  placeholder = 'Search airport, navaid or waypoint',
  kinds,
  autoFocus,
  clearOnPick = true,
}: {
  onPick: (r: SearchResult) => void;
  placeholder?: string;
  kinds?: SearchResult['kind'][];
  autoFocus?: boolean;
  clearOnPick?: boolean;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const listId = useId();
  const seq = useRef(0);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    const n = ++seq.current;
    setBusy(true);
    const timer = window.setTimeout(() => {
      api
        .search(query)
        .then((r) => {
          if (n !== seq.current) return;
          setResults(kinds ? r.filter((x) => kinds.includes(x.kind)) : r);
          setActive(0);
        })
        .catch(() => undefined)
        .finally(() => n === seq.current && setBusy(false));
    }, 160);
    return () => window.clearTimeout(timer);
    // kinds is a static prop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const pick = (r: SearchResult) => {
    onPick(r);
    setOpen(false);
    if (clearOnPick) setQ('');
    else setQ(r.ident);
  };

  return (
    <div className="place-search">
      <div className="place-search__box">
        <Icon name="search" />
        <input
          value={q}
          autoFocus={autoFocus}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' && results[active]) {
              e.preventDefault();
              pick(results[active]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
        />
        {busy && <span className="spinner" aria-label="Searching" />}
      </div>
      {open && q.trim().length >= 2 && (
        <ul className="place-search__list" id={listId} role="listbox">
          {results.length === 0 && !busy && <li className="place-search__none">Nothing found for “{q.trim()}”.</li>}
          {results.map((r, i) => (
            <li
              key={`${r.kind}-${r.ident}-${r.lat}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(r);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <strong>{r.ident}</strong>
              <span className="place-search__desc">{describe(r)}</span>
              <span className={`kind kind--${r.kind}`}>{KIND_LABEL[r.kind]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
