import React, { useEffect } from 'react';
import { getRadarReels } from '../api';

export default function RadarTab() {
  useEffect(() => {
    getRadarReels({ status: 'new' })
      .then(({ data }) => {
        console.log('Radar reels:', data.reels?.length || 0);
      })
      .catch((err) => {
        console.error('Failed to load Radar reels:', err);
      });
  }, []);

  return <div className="text-white">Radar</div>;
}
