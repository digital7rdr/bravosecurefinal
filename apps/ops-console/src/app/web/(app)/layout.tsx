import type {ReactNode} from 'react';
import {WebShell} from '@/components/web/WebShell';

export default function WebAppLayout({children}: {children: ReactNode}) {
  return <WebShell>{children}</WebShell>;
}
