// Sentences built from contextbench.json (vs_native: mean over the task sizes where native compaction ran).
export function wallTimeSentence(vs) {
  const w = vs.agent_wall_s;
  const r = vs.requests;
  const longer = w.smart > w.s2 ? 'longer' : 'shorter';
  const more = r.smart > r.s2 ? 'more' : 'fewer';
  return `Wall time per trial is ${longer} with OpenMem (${Math.round(w.smart)} s vs ${Math.round(w.s2)} s for native compaction); OpenMem also makes ${more} requests per trial (${Math.round(r.smart)} vs ${Math.round(r.s2)}), which include its store searches.`;
}
