import '../ui/base.css';
import './merge.css';
import { startMergeView } from './view';

const state = JSON.parse(document.getElementById('initial-state')!.textContent!) as { workerUrl: string };
void startMergeView(state.workerUrl);
