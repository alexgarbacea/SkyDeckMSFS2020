import { useStatus } from '../lib/store';
import { Empty } from '../components/ui';

/** Shown by aircraft panels when there is no aircraft. The banner above the workspace offers the next step. */
export function NoAircraft() {
  const status = useStatus();
  return (
    <Empty title="No aircraft yet">
      <p>{status?.connection === 'connected' ? 'MSFS is connected. Start a flight and this panel fills in.' : 'This panel fills in once MSFS is running a flight.'}</p>
    </Empty>
  );
}
