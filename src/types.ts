export type AuthMethod = "sasl" | "saslExternal" | "NickServ";

export interface ServerConfig {
  id: string;
  name?: string;
  via?: string;
  host: string;
  port?: number;
  tls?: boolean;
  nick: string;
  username?: string;
  realname?: string;
  password?: string;
  serverPassword?: string;
  authMethod?: AuthMethod;
  channels?: string[];
  autoConnect?: boolean;
}

export interface AppConfig {
  servers: ServerConfig[];
}

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error";

export type MessageKind =
  | "message"
  | "action"
  | "notice"
  | "system"
  | "join"
  | "part"
  | "error";

export interface ChatMessage {
  id: string;
  msgid?: string;
  timestamp: Date;
  kind: MessageKind;
  from?: string;
  text: string;
  isMention?: boolean;
  isSelf?: boolean;
  isHistory?: boolean;
}

export interface NickEntry {
  prefix: string;
  nick: string;
}

export type BufferKind = "status" | "channel" | "dm";

export interface BufferState {
  name: string;
  kind: BufferKind;
  topic: string;
  messages: ChatMessage[];
  users: NickEntry[];
  unread: number;
  hasMention: boolean;
  firstUnreadId?: string;
}

export interface ReconnectInfo {
  attempt: number;
  nextRetryAt: number;
}

export interface ServerState {
  id: string;
  name: string;
  networkName?: string;
  via?: string;
  config: ServerConfig;
  status: ConnectionStatus;
  reconnectInfo?: ReconnectInfo;
  nick: string;
  tls: boolean;
  buffers: Record<string, BufferState>;
  bufferOrder: string[];
}

export interface ActiveBuffer {
  serverId: string;
  buffer: string;
}

export interface StoreSnapshot {
  servers: ServerState[];
  active: ActiveBuffer | null;
}
