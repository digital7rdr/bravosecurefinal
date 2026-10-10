import type {ReactNode} from 'react';
import {HubShell} from '@/components/hub/HubShell';

export default function HubAppLayout({children}: {children: ReactNode}) {
  return <HubShell>{children}</HubShell>;
}
