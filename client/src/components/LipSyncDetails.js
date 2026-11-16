import React from 'react';

const verdictLabels = { live_speech: 'Live speech', lip_sync: 'Lip sync', unsure: 'Unsure' };

export default function LipSyncDetails({ reel }) {
  let evidence = [];
  try {
    const value = typeof reel.ai_lipsync_evidence === 'string' ? JSON.parse(reel.ai_lipsync_evidence) : reel.ai_lipsync_evidence;
    if (Array.isArray(value)) evidence = value.filter(item => typeof item === 'string').slice(0, 4);
  } catch {}
  if (!reel.ai_lipsync_verdict && !reel.lipsync_repeat_of) return null;

  return <details className="mt-2 rounded-lg border border-gray-700 bg-gray-800/50 p-2 text-xs">
    <summary className="cursor-pointer text-gold">Lip-sync check: {verdictLabels[reel.ai_lipsync_verdict] || 'Repeated audio'}{reel.ai_lipsync_confidence != null && ` · ${Math.round(Number(reel.ai_lipsync_confidence) * 100)}%`}</summary>
    {evidence.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-4 text-gray-300">{evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>}
    {reel.lipsync_repeat_of && <p className="mt-2 text-gray-400">Repeated words also found in reel #{reel.lipsync_repeat_of}.</p>}
  </details>;
}
