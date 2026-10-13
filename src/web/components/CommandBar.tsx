import { useEffect, useMemo, useRef, useState } from 'react';
import { EXAMPLES, parseCommand, type ParsedAction } from '../lib/commands';
import { act, getState, send } from '../lib/store';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { openPanel } from '../lib/workspace';
import { bestRunway, repositionCommand, runwayOptions } from '../lib/reposition';
import { panelById } from '../panels/registry';
import { sendPlanToSim, startDirectTo } from '../panels/FlightPlanPanel';
import { Icon } from './ui';

const AP_STATE_KEY = {
  master: 'master',
  hdg: 'hdgMode',
  nav: 'navMode',
  apr: 'aprMode',
  alt: 'altMode',
  vs: 'vsMode',
  flc: 'flcMode',
  flightDirector: 'flightDirector',
  yawDamper: 'yawDamper',
} as const;

async function run(action: ParsedAction) {
  const t = getState().telemetry;
  switch (action.kind) {
    case 'command':
      await send(action.command);
      break;
    case 'apMode': {
      const current = t?.autopilot[AP_STATE_KEY[action.mode]];
      if (action.on !== undefined && current === action.on) break;
      await send({ type: 'ap.toggle', mode: action.mode });
      break;
    }
    case 'lights':
      action.lights.forEach((light) => act({ type: 'light.set', light, on: action.on }));
      break;
    case 'localTime': {
      if (!t) throw new Error('No aircraft connected.');
      const offset = Math.round((t.sim.localSeconds - t.sim.zuluSeconds) / 60);
      const total = (((action.hour * 60 + action.minute - offset) % 1440) + 1440) % 1440;
      await send({ type: 'sim.time', zuluHour: Math.floor(total / 60), zuluMinute: total % 60 });
      break;
    }
    case 'direct':
      startDirectTo(action.ident);
      break;
    case 'reposition': {
      const airport = await api.airport(action.ident);
      const options = runwayOptions(airport);
      const rw = action.runway ? options.find((o) => o.ident === action.runway) : bestRunway(options, t?.environment.windDir);
      if (!rw) throw new Error(action.runway ? `${airport.ident} has no runway ${action.runway}.` : `No runway data for ${airport.ident}.`);
      await send(repositionCommand(airport, rw, action.finalNm, 90));
      break;
    }
    case 'route': {
      const res = await api.route(action.route);
      toast(res.skipped.length ? `Flight plan created. Skipped: ${res.skipped.join(', ')}` : `Flight plan ${res.plan.title} created.`, 'success');
      break;
    }
    case 'sendPlan':
      await sendPlanToSim();
      break;
    case 'simbrief': {
      const p = await api.importSimbrief();
      toast(`Imported ${p.title} from SimBrief.`, 'success');
      break;
    }
    case 'panel': {
      const def = panelById(action.id);
      if (def) openPanel(def.id, def.title);
      break;
    }
  }
}

/** Ctrl+K: type what you want ("alt 8000", "com1 121.5", "direct LGAV") instead of hunting for the control. */
export function CommandBar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseCommand(text), [text]);
  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return EXAMPLES;
    const first = q.split(' ')[0];
    return EXAMPLES.filter((e) => e.text.startsWith(first) || e.does.toLowerCase().includes(q)).slice(0, 6);
  }, [text]);

  useEffect(() => {
    if (open) {
      setText('');
      setHistIdx(-1);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!parsed.action) {
      if (text.trim()) toast(parsed.hint ?? `SkyDeck doesn't understand “${text.trim()}”. Pick one of the examples below.`, 'warning');
      return;
    }
    const action = parsed.action;
    setHistory((h) => [text.trim(), ...h.filter((x) => x !== text.trim())].slice(0, 20));
    onClose();
    try {
      await run(action);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="command-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="command" role="dialog" aria-label="Command bar">
        <form
          className="command__input"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Icon name="keyboard" size={18} />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a command, e.g. alt 8000 or com1 121.5"
            aria-label="Command"
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowUp' && history.length) {
                e.preventDefault();
                const i = Math.min(history.length - 1, histIdx + 1);
                setHistIdx(i);
                setText(history[i]);
              }
              if (e.key === 'ArrowDown' && histIdx >= 0) {
                e.preventDefault();
                const i = histIdx - 1;
                setHistIdx(i);
                setText(i >= 0 ? history[i] : '');
              }
              if (e.key === 'Tab' && suggestions[0] && !parsed.action) {
                e.preventDefault();
                setText(suggestions[0].text.split(' ')[0] + ' ');
              }
            }}
          />
          <kbd>Enter</kbd>
        </form>
        <div className="command__preview" aria-live="polite">
          {parsed.action ? (
            <span className="command__will">{parsed.action.label}</span>
          ) : parsed.hint ? (
            <span className="command__hint">{parsed.hint}</span>
          ) : text.trim() ? (
            <span className="command__hint">Not a command yet. Try one of these:</span>
          ) : (
            <span className="command__hint">Things you can type:</span>
          )}
        </div>
        {!parsed.action && suggestions.length > 0 && (
          <ul className="command__examples">
            {suggestions.map((s) => (
              <li key={s.text}>
                <button type="button" onClick={() => { setText(s.text); inputRef.current?.focus(); }}>
                  <code>{s.text}</code>
                  <span>{s.does}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
