/**
 * B-636 (client, 2026-08-23) — the message half of the Channels search.
 *
 * "This search option should allow you to also search for conversations or
 * words in conversations that's inside the chats."
 *
 * Renders under the channel tree while a search is running: one row per matching
 * message, newest-first, with the matched term highlighted in its own line of
 * context. Tapping a row opens the channel the message is in.
 *
 * ── SECTIONED BY ORGANISATION, LIKE THE TREE ABOVE IT ─────────────────────
 *
 * B-624 was "different organization channels must never mix… It must ALWAYS be
 * separate here", and the tree obeys it by rendering one tree per organisation.
 * A flat hit list underneath would put the same pile back on the screen under a
 * different name, so the sections are the caller's own organisation sections and
 * the headings are the caller's own labels.
 *
 * ── WHY THIS IS ITS OWN COMPONENT ─────────────────────────────────────────
 *
 * B-623's lesson: a screen too big to mount in a test is a screen whose
 * behaviour is pinned by source scans, and a scan cannot see whether a value is
 * USED. This mounts on its own in the app Jest project, so the tests press the
 * real rows.
 *
 * ── B-838: A DOCUMENT MUST READ AS A DOCUMENT ─────────────────────────────
 *
 * "User should see the docs also." A media hit gets the sender's thumbnail
 * when it has one, otherwise the same glyph the Files screen draws, and a
 * file/video/audio row is TITLED by its file name — a document is identified
 * by what it is called, not by whichever eight words surround the match.
 */
import React from 'react';
import {View, Text, Image, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@theme/bravo';
import {formatListTimestamp} from '@utils/helpers';
import {OB, Card, SectionLabel} from '@screens/deptchat/_obsidian';
import {mediaKindIcon} from '@/modules/messenger/ui/mediaKind';
import type {ChannelMessageHit} from '@screens/deptchat/channelMessageSearch';

export interface ChannelMessageHitsProps {
  sections: ReadonlyArray<{orgId: string | null; hits: ChannelMessageHit[]}>;
  /** The organisation heading, from the SAME resolver the channel tree uses so
   *  one organisation cannot read as two different names on one screen. */
  labelFor: (orgId: string | null) => string;
  /** Whether organisation headings are shown at all — false on the ordinary
   *  single-organisation screen, where a heading would be noise. */
  showOrgLabels: boolean;
  onOpen: (hit: ChannelMessageHit) => void;
}

export function ChannelMessageHits({
  sections, labelFor, showOrgLabels, onOpen,
}: ChannelMessageHitsProps): React.ReactElement | null {
  if (sections.length === 0) {return null;}
  return (
    <View testID="channel-message-hits">
      {sections.map(section => (
        <View key={`msgs-${section.orgId ?? 'none'}`} style={s.block}>
          <SectionLabel numberOfLines={2}>
            {showOrgLabels
              ? `${labelFor(section.orgId)} · Messages`
              : 'Messages'}
          </SectionLabel>
          <Card style={s.card}>
            {section.hits.map((hit, i) => (
              <HitRow
                key={`${hit.conversationId}:${hit.messageId}`}
                hit={hit}
                last={i === section.hits.length - 1}
                onPress={() => onOpen(hit)}
              />
            ))}
          </Card>
        </View>
      ))}
    </View>
  );
}

function HitRow({hit, last, onPress}: {
  hit: ChannelMessageHit;
  last: boolean;
  onPress: () => void;
}): React.ReactElement {
  const {before, match, after} = hit.snippet;
  const glyph = mediaKindIcon(hit.bucket, hit.mime);
  // A photo is identified by the photo; a document by what it is called. So the
  // file name is a title on file/video/audio rows only — on an image it would
  // just be `IMG_20260910.jpg` above the caption that actually says something.
  const title = hit.kind !== 'image' ? hit.fileName : null;
  return (
    <TouchableOpacity
      testID={`channel-msg-hit-${hit.messageId}`}
      style={[s.row, !last && s.rowDivider]}
      activeOpacity={0.75}
      onPress={onPress}
      accessibilityRole="button"
      // The channel is named first because it is what the tap DOES; the body
      // follows as the reason this row is here.
      accessibilityLabel={`Open ${hit.channelName}. ${title ? `${title}. ` : ''}Message: ${before}${match}${after}`}>
      <View style={s.rowInner}>
        {hit.thumbB64 ? (
          <Image
            testID={`msg-hit-thumb-${hit.messageId}`}
            source={{uri: `data:image/jpeg;base64,${hit.thumbB64}`}}
            style={s.thumb}
          />
        ) : (
          <View style={[s.kind, !glyph && s.kindPlain]}>
            {glyph
              ? <Icon testID={`msg-hit-icon-${hit.messageId}`} name={glyph} size={15} color={OB.accentSoft} />
              : <Icon name="pound" size={13} color={OB.textMute} />}
          </View>
        )}
        <View style={s.rowMain}>
          <View style={s.rowHead}>
            <Text style={s.channel} numberOfLines={1}>{hit.channelName}</Text>
            <Text style={s.when}>{formatListTimestamp(hit.createdAt)}</Text>
          </View>
          {title ? (
            <Text testID={`msg-hit-name-${hit.messageId}`} style={s.fileName} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
          {/* One line, ellipsised: the snippet is already centred on the match,
              so a second line would push the highlight off its own row. */}
          <Text style={s.body} numberOfLines={1}>
            <Text style={s.bodyDim}>{before}</Text>
            <Text style={s.bodyHit}>{match}</Text>
            <Text style={s.bodyDim}>{after}</Text>
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  block: {marginBottom: 18},
  card: {paddingHorizontal: 0, paddingVertical: 0, overflow: 'hidden'},
  // 56dp of vertical room across two lines — comfortably over the 44dp target.
  row: {paddingHorizontal: 14, paddingVertical: 11},
  rowDivider: {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: OB.hair},
  rowInner: {flexDirection: 'row', alignItems: 'center', gap: 10},
  rowMain: {flex: 1, minWidth: 0, gap: 3},
  // The kind marker column: a thumbnail, a media glyph, or the channel hash.
  kind: {
    width: 32, height: 32, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(91,141,239,0.25)',
  },
  // A text hit keeps the bare hash it always had — a tinted tile would read as
  // an attachment on a row that has none.
  kindPlain: {backgroundColor: 'transparent', borderColor: 'transparent'},
  thumb: {width: 32, height: 32, borderRadius: 9, backgroundColor: OB.hair},
  rowHead: {flexDirection: 'row', alignItems: 'center', gap: 6},
  fileName: {
    color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 12.5, letterSpacing: 0.1,
  },
  channel: {
    flex: 1, minWidth: 0,
    color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 13, letterSpacing: 0.1,
  },
  when: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10},
  body: {fontFamily: BravoFont.sans, fontSize: 12.5, lineHeight: 17},
  bodyDim: {color: OB.textDim},
  // The one accent on the row — it is the answer to what was typed.
  bodyHit: {color: OB.accentSoft, fontFamily: BravoFont.semiBold},
});
