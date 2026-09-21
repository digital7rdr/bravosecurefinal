'use client';
import {use} from 'react';
import {MissionDetail} from '@/features/missions/MissionDetail';
export default function Page({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  return <MissionDetail id={id} product="executive" />;
}
