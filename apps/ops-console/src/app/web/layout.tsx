import type {Metadata} from 'next';
import type {ReactNode} from 'react';

export const metadata: Metadata = {
  title: 'Bravo Secure Web',
  description: 'Bravo Secure on the web: encrypted Messenger and online booking',
};

export default function WebRootLayout({children}: {children: ReactNode}) {
  return children;
}
