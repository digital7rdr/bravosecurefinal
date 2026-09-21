'use client';

import {use} from 'react';
import {ReferralCampaignDetail} from '@/features/finance/ReferralCampaignDetail';

export default function Page({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  return <ReferralCampaignDetail id={id} />;
}
