import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BrewingInit, BrewingMethods, BrewingOutputEvent, BrewingStatusEvent } from '../../shared/protocol';
import { BrewingDialog } from '../ui/BrewingDialog';
import { createClient, onHostEvent } from '../ui/rpc';
import '../ui/base.css';

const request = createClient<BrewingMethods>();

function App() {
  const [init, setInit] = useState<BrewingInit | null>(null);
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<'brewing' | 'success' | 'error'>('brewing');
  const [errorMsg, setErrorMsg] = useState<string | undefined>(undefined);

  useEffect(() => {
    void request('init', null).then((data) => {
      setInit(data);
      setStatus(data.status);
      if (data.initialLines?.length) {
        setOutput(data.initialLines.join('\n') + '\n');
      }
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    return onHostEvent((raw) => {
      const e = raw as unknown as BrewingOutputEvent | BrewingStatusEvent;
      if (e.event === 'output') {
        setOutput((prev) => prev + (e as BrewingOutputEvent).chunk);
      } else if (e.event === 'status') {
        const s = e as BrewingStatusEvent;
        setStatus(s.status);
        if (s.error) setErrorMsg(s.error);
      }
    });
  }, []);

  if (!init) return null;

  return (
    <BrewingDialog
      title={init.title}
      repoName={init.repoName}
      command={init.command}
      status={status}
      output={output}
      error={errorMsg}
      hasConflicts={/conflict/i.test(output) || /conflict/i.test(errorMsg ?? '')}
      onClose={() => void request('close', null)}
    />
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
