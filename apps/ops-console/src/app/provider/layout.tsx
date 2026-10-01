import type {Metadata} from 'next';
import type {ReactNode} from 'react';

export const metadata: Metadata = {
  title: 'Bravo Provider Console',
  description: 'Bravo Secure — run your agency: jobs, officers and earnings',
};

export default function ProviderRootLayout({children}: {children: ReactNode}) {
  return children;
}
