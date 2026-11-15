import React, { useState } from 'react';

export default function Transcript({ transcript }) {
  const [copyStatus, setCopyStatus] = useState('');
  if (!transcript) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(transcript);
      setCopyStatus('Copied');
    } catch {
      setCopyStatus('Could not copy. Select the transcript to copy it.');
    }
  };

  return (
    <details className="mt-2 rounded-lg border border-gray-700 bg-gray-800/50 p-2 text-xs">
      <summary className="cursor-pointer text-gold">Transcript</summary>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span role="status" className="text-gray-400">{copyStatus}</span>
        <button type="button" onClick={copy} aria-label="Copy transcript" className="rounded border border-gray-600 px-2 py-1 text-gray-300 hover:text-white">Copy</button>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed text-gray-300">{transcript}</p>
    </details>
  );
}
