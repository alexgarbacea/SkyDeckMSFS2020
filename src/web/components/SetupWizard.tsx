import { useEffect, useState } from 'react';
import type { MsfsInstallCandidate, Settings } from '../../shared/types';
import { api } from '../lib/api';
import { useSettings } from '../lib/store';
import { Button, Segmented, Switch } from './ui';
import { FolderPicker } from './FolderPicker';

function SimFolderStep({ value, onChange }: { value: string | null; onChange: (c: MsfsInstallCandidate | null) => void }) {
  const [found, setFound] = useState<MsfsInstallCandidate[] | null>(null);
  const [custom, setCustom] = useState<MsfsInstallCandidate | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .detectInstalls()
      .then((list) => {
        setFound(list);
        if (!value && list[0]) onChange(list[0]);
      })
      .catch(() => setFound([]));
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const options = [...(found ?? []), ...(custom ? [custom] : [])];
  return (
    <>
      <p className="setup__lead">
        SkyDeck reads the flight plan you set up on the MSFS World Map from this folder. Everything else works without it, so you can also skip this.
      </p>
      {found === null && <p className="muted">Looking for Microsoft Flight Simulator…</p>}
      {found && found.length === 0 && !custom && <p className="warning-text">SkyDeck could not find MSFS in the usual places. Choose the folder yourself.</p>}
      <div className="option-list" role="radiogroup" aria-label="Simulator folder">
        {options.map((c) => (
          <button key={c.dataPath} type="button" role="radio" aria-checked={value === c.dataPath} className={`option-card ${value === c.dataPath ? 'is-on' : ''}`} onClick={() => onChange(c)}>
            <strong>{c.label}</strong>
            <code>{c.dataPath}</code>
            <span className="muted small">
              {c.packagesPath ? `Add-ons (Community folder) in ${c.packagesPath}` : 'Add-on folder not found'}
              {c.hasFlightPlan ? ', World Map flight plan found' : ''}
            </span>
          </button>
        ))}
      </div>
      <div className="chip-row">
        <Button onClick={() => setPicking(true)}>Choose another folder…</Button>
        {value && (
          <Button variant="ghost" onClick={() => onChange(null)}>
            Skip, I'll set it later
          </Button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      {picking && (
        <FolderPicker
          start={value}
          onClose={() => setPicking(false)}
          onPick={(path) => {
            api
              .inspectFolder(path)
              .then((c) => {
                setCustom(c);
                onChange(c);
                setPicking(false);
                setError('');
              })
              .catch((e: Error) => {
                setError(e.message);
                setPicking(false);
              });
          }}
        />
      )}
    </>
  );
}

const STEPS = ['Simulator', 'Preferences', 'Ready'] as const;

/** First-run setup. Shown until the user finishes it; everything here can be changed later in Settings. */
export function SetupWizard() {
  const settings = useSettings();
  const [step, setStep] = useState(0);
  const [install, setInstall] = useState<MsfsInstallCandidate | null>(null);
  const [prefs, setPrefs] = useState<Pick<Settings, 'units' | 'simbriefUser' | 'allowLan'>>({
    units: settings?.units ?? { pressure: 'inHg', weight: 'lbs' },
    simbriefUser: settings?.simbriefUser ?? '',
    allowLan: settings?.allowLan ?? false,
  });
  const [saving, setSaving] = useState(false);

  const finish = async () => {
    setSaving(true);
    try {
      await api.saveSettings({
        ...prefs,
        msfsDataPath: install?.dataPath ?? null,
        msfsPackagesPath: install?.packagesPath ?? null,
        setupComplete: true,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="setup">
      <div className="setup__card">
        <header className="setup__head">
          <svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
            <path d="M16 4l2.2 9.5L28 18v2.4l-9.8-2.6-.6 6.4 3 2.3V28L16 26.6 11.4 28v-1.5l3-2.3-.6-6.4L4 20.4V18l9.8-4.5z" fill="var(--cyan)" />
          </svg>
          <div>
            <h1>Welcome to SkyDeck</h1>
            <p>Your aircraft, map and flight plan on a second screen. Two quick questions and you're flying.</p>
          </div>
        </header>
        <ol className="setup__steps" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? 'is-current' : i < step ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined}>
              <span>{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>

        <div className="setup__body">
          {step === 0 && (
            <>
              <h2>Where is Microsoft Flight Simulator?</h2>
              <SimFolderStep value={install?.dataPath ?? null} onChange={setInstall} />
            </>
          )}
          {step === 1 && (
            <>
              <h2>A few preferences</h2>
              <div className="form-grid">
                <span className="form-grid__label">Altimeter setting in</span>
                <Segmented label="Pressure units" value={prefs.units.pressure} onChange={(pressure) => setPrefs({ ...prefs, units: { ...prefs.units, pressure } })} options={[{ value: 'inHg', label: 'inHg (29.92)' }, { value: 'hPa', label: 'hPa (1013)' }]} />
                <span className="form-grid__label">Weights in</span>
                <Segmented label="Weight units" value={prefs.units.weight} onChange={(weight) => setPrefs({ ...prefs, units: { ...prefs.units, weight } })} options={[{ value: 'lbs', label: 'Pounds' }, { value: 'kg', label: 'Kilograms' }]} />
                <label className="form-grid__label" htmlFor="sb-user">
                  SimBrief username
                </label>
                <div>
                  <input id="sb-user" value={prefs.simbriefUser} onChange={(e) => setPrefs({ ...prefs, simbriefUser: e.target.value })} placeholder="Optional" />
                  <p className="muted small">Lets you import your latest SimBrief plan with one click.</p>
                </div>
              </div>
              <Switch
                checked={prefs.allowLan}
                onChange={(allowLan) => setPrefs({ ...prefs, allowLan })}
                label="Let other devices on my network open SkyDeck"
                hint="For a tablet or laptop next to you. Anyone on your home network could then control the sim. Windows may ask to allow network access."
              />
            </>
          )}
          {step === 2 && (
            <>
              <h2>You're set</h2>
              <ul className="setup__tips">
                <li>
                  <strong>Start a flight in MSFS.</strong> SkyDeck connects by itself, with no buttons to press. Keep the SkyDeck window open while you fly.
                </li>
                <li>
                  <strong>Drag panel tabs</strong> to split the screen any way you like. The <em>expand</em> button on a panel opens its detailed view.
                </li>
                <li>
                  <strong>Press Ctrl+K</strong> and type commands like <code>alt 8000</code>, <code>com1 121.5</code> or <code>direct LGAV</code>.
                </li>
                <li>
                  <strong>Right-click the map</strong> to fly direct to a point, add it to your route, or move the aircraft there.
                </li>
              </ul>
            </>
          )}
        </div>

        <footer className="setup__foot">
          {step > 0 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          <span className="spacer" />
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => setStep(step + 1)}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" disabled={saving} onClick={() => void finish()}>
              Open SkyDeck
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
