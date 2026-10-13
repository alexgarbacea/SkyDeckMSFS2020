import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { useSettings } from '../lib/store';
import { toast } from '../lib/toast';
import { Button, Modal } from './ui';

type Mode = 'simbrief' | 'msfs' | 'file' | 'route';

/** One place for every way of getting a flight plan into SkyDeck. */
export function ImportDialog({ onClose, initial = 'simbrief' }: { onClose: () => void; initial?: Mode }) {
  const settings = useSettings();
  const [mode, setMode] = useState<Mode>(initial);
  const [user, setUser] = useState(settings?.simbriefUser ?? '');
  const [route, setRoute] = useState('');
  const [cruise, setCruise] = useState('8000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError('');
    try {
      toast(await fn(), 'success');
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const options: Array<{ id: Mode; title: string; text: string }> = [
    { id: 'simbrief', title: 'SimBrief', text: 'Your latest SimBrief flight plan, with runways and procedures.' },
    { id: 'msfs', title: 'MSFS World Map', text: 'The plan you set up in the sim before pressing Fly.' },
    { id: 'file', title: 'A .PLN file', text: 'From Little Navmap, SimBrief downloads or anywhere else.' },
    { id: 'route', title: 'Type a route', text: 'Airports, navaids and waypoints separated by spaces.' },
  ];

  return (
    <Modal title="Import a flight plan" onClose={onClose} wide>
      <div className="import">
        <div className="import__options" role="radiogroup" aria-label="Import from">
          {options.map((o) => (
            <button key={o.id} type="button" role="radio" aria-checked={mode === o.id} className={`option-card ${mode === o.id ? 'is-on' : ''}`} onClick={() => { setMode(o.id); setError(''); }}>
              <strong>{o.title}</strong>
              <span>{o.text}</span>
            </button>
          ))}
        </div>
        <div className="import__form">
          {mode === 'simbrief' && (
            <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const p = await api.importSimbrief(user); return `Imported ${p.title} from SimBrief.`; }); }}>
              <label className="field">
                <span>SimBrief username or pilot ID</span>
                <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="e.g. pilot123" autoFocus />
              </label>
              <p className="muted">SkyDeck loads the most recent flight you generated on simbrief.com. Your username is remembered.</p>
              <Button type="submit" variant="primary" disabled={busy || !user.trim()}>
                {busy ? 'Importing…' : 'Import from SimBrief'}
              </Button>
            </form>
          )}
          {mode === 'msfs' && (
            <div>
              <p>Plan a flight on the MSFS World Map and press Fly. SkyDeck reads the plan the sim saved for that flight.</p>
              {!settings?.msfsDataPath && <p className="warning-text">Set the simulator folder in Settings first.</p>}
              <Button variant="primary" disabled={busy || !settings?.msfsDataPath} onClick={() => void run(async () => { const p = await api.importMsfs(); return `Imported ${p.title} from MSFS.`; })}>
                {busy ? 'Importing…' : 'Import from MSFS'}
              </Button>
            </div>
          )}
          {mode === 'file' && (
            <div>
              <p>Choose an MSFS flight plan file (.pln).</p>
              <input
                ref={fileRef}
                type="file"
                accept=".pln,.PLN,application/xml,text/xml"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  void run(async () => {
                    const p = await api.importPln(await file.text());
                    return `Imported ${p.title} from ${file.name}.`;
                  });
                }}
              />
              <Button variant="primary" icon="upload" disabled={busy} onClick={() => fileRef.current?.click()}>
                Choose file
              </Button>
            </div>
          )}
          {mode === 'route' && (
            <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api.route(route, Number(cruise) || 8000); return r.skipped.length ? `Route created. Skipped: ${r.skipped.join(', ')}` : `Route created: ${r.plan.title}.`; }); }}>
              <label className="field">
                <span>Route</span>
                <textarea value={route} onChange={(e) => setRoute(e.target.value)} rows={3} placeholder="LGIR SIT KEA LGAV" autoFocus />
              </label>
              <label className="field field--inline">
                <span>Cruise altitude (ft)</span>
                <input value={cruise} onChange={(e) => setCruise(e.target.value)} inputMode="numeric" size={7} />
              </label>
              <p className="muted">Named waypoints (like ASTON) are looked up in MSFS, so connect the sim for those. Airways are not expanded: list their waypoints instead.</p>
              <Button type="submit" variant="primary" disabled={busy || route.trim().split(/\s+/).length < 2}>
                {busy ? 'Building…' : 'Create flight plan'}
              </Button>
            </form>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
