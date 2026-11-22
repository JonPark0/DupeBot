import {
  ApplicationCommandType,
  ChannelType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  type RESTPostAPIApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from 'discord.js';
import { RESPONSE_MODES } from '../modes.ts';

export const NOT_DUPLICATE = '중복 아님';

const TEXT_CHANNELS = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
  ChannelType.GuildVoice,
] as const;

// Forum and media channels hold no messages themselves, only threads
const MESSAGE_CHANNELS = TEXT_CHANNELS.filter(
  (type) => type !== ChannelType.GuildForum && type !== ChannelType.GuildMedia,
);

const dupe = new SlashCommandBuilder()
  .setName('dupe')
  .setDescription('DupeBot 중복 게시물 감지 설정')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('config')
      .setDescription('설정 보기/변경 (옵션 없이 실행하면 현재 설정을 보여줍니다)')
      .addStringOption((o) => o.setName('emoji').setDescription('중복 게시물에 달 이모지'))
      .addStringOption((o) => o.setName('semantic_emoji').setDescription('비슷한 내용(Claude 판정)에 달 이모지'))
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('반응 방식')
          .addChoices(
            ...RESPONSE_MODES.map((mode) => ({
              name: { forward: 'forward (원본 전달)', reply: 'reply (링크 답장)', react: 'react (이모지만)' }[mode],
              value: mode,
            })),
          ),
      )
      .addIntegerOption((o) =>
        o.setName('threshold').setDescription('같은 사진으로 볼 dHash 차이 (0~20, 기본 6)').setMinValue(0).setMaxValue(20),
      )
      .addIntegerOption((o) =>
        o
          .setName('same_author_minutes')
          .setDescription('같은 작성자가 이 시간(분) 안에 다시 올리면 무시 (0 = 항상 감지)')
          .setMinValue(0)
          .setMaxValue(1440),
      )
      .addBooleanOption((o) => o.setName('semantic').setDescription('Claude로 비슷한 기사 판정 사용')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('channel')
      .setDescription('감지할 채널 지정')
      .addStringOption((o) =>
        o
          .setName('action')
          .setDescription('include: 이 채널만 감시 목록에 추가 / exclude: 제외 / clear: 목록 초기화')
          .setRequired(true)
          .addChoices(
            { name: 'include (감시 목록에 추가)', value: 'include' },
            { name: 'exclude (제외 목록에 추가)', value: 'exclude' },
            { name: 'remove (두 목록에서 빼기)', value: 'remove' },
            { name: 'clear (두 목록 비우기 = 모든 채널 감시)', value: 'clear' },
          ),
      )
      .addChannelOption((o) => o.setName('channel').setDescription('대상 채널').addChannelTypes(...TEXT_CHANNELS)),
  )
  .addSubcommand((sub) =>
    sub
      .setName('relay')
      .setDescription('링크 변환 봇(원래 글을 지우고 다시 올리는 봇)의 글을 그 회원의 글로 감지')
      .addStringOption((o) =>
        o
          .setName('action')
          .setDescription('add: 추가 / remove: 빼기 / list: 목록 보기')
          .setRequired(true)
          .addChoices(
            { name: 'add (추가)', value: 'add' },
            { name: 'remove (빼기)', value: 'remove' },
            { name: 'list (목록 보기)', value: 'list' },
          ),
      )
      .addUserOption((o) => o.setName('bot').setDescription('대상 봇'))
      .addStringOption((o) => o.setName('id').setDescription('봇 계정이 아닌 웹훅·앱이면 그 ID')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('backfill')
      .setDescription('과거 메시지를 색인합니다 (반응은 달지 않음)')
      .addChannelOption((o) =>
        o.setName('channel').setDescription('색인할 채널').setRequired(true).addChannelTypes(...MESSAGE_CHANNELS),
      )
      .addIntegerOption((o) =>
        o.setName('limit').setDescription('최대 메시지 수 (기본 1000, 최대 20000)').setMinValue(1).setMaxValue(20000),
      ),
  );

const status = new SlashCommandBuilder()
  .setName('status')
  .setDescription('DupeBot 상태 (DB, Claude, 오늘 사용량)')
  .setContexts(InteractionContextType.Guild);

const notDuplicate = new ContextMenuCommandBuilder()
  .setName(NOT_DUPLICATE)
  .setType(ApplicationCommandType.Message)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .setContexts(InteractionContextType.Guild);

export const commandBodies: RESTPostAPIApplicationCommandsJSONBody[] = [dupe.toJSON(), status.toJSON(), notDuplicate.toJSON()];
