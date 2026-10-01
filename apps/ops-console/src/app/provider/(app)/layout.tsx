import type {ReactNode} from 'react';
import {ProviderShell} from '@/components/provider/ProviderShell';

export default function ProviderAppLayout({children}: {children: ReactNode}) {
  return <ProviderShell>{children}</ProviderShell>;
}
