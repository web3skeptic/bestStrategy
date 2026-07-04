// Node-only weight file I/O for the MLP. Kept OUT of ml/mlp.ts so the browser
// bundle (which imports MLP for the forward pass) never pulls in 'fs'. Node
// scripts (training / eval / headless drivers) use loadNet/saveNet; the browser
// builds nets from imported JSON via MLP.fromJSON directly.
import { readFileSync, writeFileSync } from 'fs';
import { MLP } from './mlp';

export function loadNet(path: string): MLP {
  return MLP.fromJSON(JSON.parse(readFileSync(path, 'utf8')));
}

export function saveNet(net: MLP, path: string): void {
  writeFileSync(path, JSON.stringify(net.toJSON()));
}
