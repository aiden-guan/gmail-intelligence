import { useState, type CSSProperties } from 'react';
import { orbClass, orbSvg, type OrbTone } from './orb-markup';

export function Orb({ size = 16, tone = 'paper' }: { size?: number; tone?: OrbTone }) {
  const [markup] = useState(orbSvg);
  return <span aria-hidden="true" className={orbClass(tone)} style={{ fontSize: size } as CSSProperties}
    dangerouslySetInnerHTML={{ __html: markup }} />;
}
