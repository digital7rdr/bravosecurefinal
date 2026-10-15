import type {Metadata} from 'next';
import type {ReactNode} from 'react';

export const metadata: Metadata = {
  title: 'Bravo Secure',
  description: 'Bravo Secure — the secure enterprise solution for comms, movement, management and processes: sign in once to every Bravo Secure app',
};

export default function HubRootLayout({children}: {children: ReactNode}) {
  return children;
}
