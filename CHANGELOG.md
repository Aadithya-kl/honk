# Changelog

## [0.3.0](https://github.com/agustingianni/honk/compare/v0.2.0...v0.3.0) (2026-11-27)


### Features

* click a nick in the chat to message them ([#13](https://github.com/agustingianni/honk/issues/13)) ([21437eb](https://github.com/agustingianni/honk/commit/21437ebbd8cce4b09f04ea2bfd1d070fbcd2dbf8))
* click nicks and channel names in messages to open a DM or join ([#71](https://github.com/agustingianni/honk/issues/71)) ([0c2b3d7](https://github.com/agustingianni/honk/commit/0c2b3d7622ba50edfdea882cb4703cd782de3753))
* highlight nicks, buffers, and omnibox rows under the mouse ([#11](https://github.com/agustingianni/honk/issues/11)) ([7d6ee11](https://github.com/agustingianni/honk/commit/7d6ee117f246551cd3ff9d1657e3cfabaf3d6a80))
* open links in messages and the topic with a plain click ([deb9f03](https://github.com/agustingianni/honk/commit/deb9f03ac16b2b2342f0d32bb8723bfd9f248f39))
* show where you left off after a restart, synced with your other clients ([#40](https://github.com/agustingianni/honk/issues/40)) ([bb23743](https://github.com/agustingianni/honk/commit/bb23743bcb3f501aad24453b33c613729f4e3d54))


### Bug Fixes

* a colored topic is no longer cut too early ([deb9f03](https://github.com/agustingianni/honk/commit/deb9f03ac16b2b2342f0d32bb8723bfd9f248f39))
* a failed /history now shows its error in the buffer you typed it in ([#41](https://github.com/agustingianni/honk/issues/41)) ([3c7e4b4](https://github.com/agustingianni/honk/commit/3c7e4b4f0328fd8ac8fd30d92a8ad6445f23c428)), closes [#32](https://github.com/agustingianni/honk/issues/32)
* a failed history fetch shows its error in its own channel ([#45](https://github.com/agustingianni/honk/issues/45)) ([8f6a3a7](https://github.com/agustingianni/honk/commit/8f6a3a7632d0d47ae28b66c7b8a84e233c009e43))
* a server that never sends a newline no longer makes honk use more and more memory ([#64](https://github.com/agustingianni/honk/issues/64)) ([f72d922](https://github.com/agustingianni/honk/commit/f72d9225ec38d25f56345e5fede2a345da5591fb))
* an error in an event handler no longer stops reading from that server ([#63](https://github.com/agustingianni/honk/issues/63)) ([ceb3bb4](https://github.com/agustingianni/honk/commit/ceb3bb4ab021bb5602f477df02ba5992c4d31b80))
* an unlabeled history error in one channel no longer loses /history replies in another ([8f6a3a7](https://github.com/agustingianni/honk/commit/8f6a3a7632d0d47ae28b66c7b8a84e233c009e43))
* colored text is readable on selected and hovered rows in every theme ([#72](https://github.com/agustingianni/honk/issues/72)) ([ad1684c](https://github.com/agustingianni/honk/commit/ad1684c403bbee2010a5491df31246e57534f0a5))
* honk no longer quits on a server line it cannot handle ([#22](https://github.com/agustingianni/honk/issues/22)) ([d342863](https://github.com/agustingianni/honk/commit/d3428633397e93d7eebadb427e182d965890d3fe)), closes [#15](https://github.com/agustingianni/honk/issues/15)
* honk upgrade gives up when a download stops sending data ([#62](https://github.com/agustingianni/honk/issues/62)) ([7748e4d](https://github.com/agustingianni/honk/commit/7748e4d0d7b0ad8952e42d51ca315d9df8ee8dce)), closes [#14](https://github.com/agustingianni/honk/issues/14)
* honk upgrade no longer hangs while downloading the release ([#9](https://github.com/agustingianni/honk/issues/9)) ([3e3e571](https://github.com/agustingianni/honk/commit/3e3e571bd876ce80b4b64053e6bebe7718d69a9b))
* keep the "new messages" divider on one line ([#19](https://github.com/agustingianni/honk/issues/19)) ([71a47bf](https://github.com/agustingianni/honk/commit/71a47bf23e368cfc7c478e3aa4bcf7021d3d14cc))
* links and notifications no longer carry hidden bidi characters ([#76](https://github.com/agustingianni/honk/issues/76)) ([d113c8b](https://github.com/agustingianni/honk/commit/d113c8b4cd26bb792356ec9ea021269c5268e429))
* say which download failed, and why, when the connection breaks ([3e3e571](https://github.com/agustingianni/honk/commit/3e3e571bd876ce80b4b64053e6bebe7718d69a9b))
* the active channel row is easy to see in every theme ([#70](https://github.com/agustingianni/honk/issues/70)) ([6f58246](https://github.com/agustingianni/honk/commit/6f5824649140fd8b7d0f9a1d0f76df52b40a65c4))
* the selected omnibox row is easy to see in every theme ([#67](https://github.com/agustingianni/honk/issues/67)) ([69ffb4c](https://github.com/agustingianni/honk/commit/69ffb4c97512bab59f74fc7016f6adaf1d770551))
* wide characters in nicks, channel names, and topics no longer break the layout ([#54](https://github.com/agustingianni/honk/issues/54)) ([d6399cb](https://github.com/agustingianni/honk/commit/d6399cb218708af67b218431668d07b1380b7209)), closes [#26](https://github.com/agustingianni/honk/issues/26)
* your own message no longer shows twice ([#53](https://github.com/agustingianni/honk/issues/53)) ([f0278c7](https://github.com/agustingianni/honk/commit/f0278c7dcb1aea409e089ddb0dd6d7a1b2a2d207))

## [0.2.0](https://github.com/agustingianni/honk/compare/v0.1.0...v0.2.0) (2026-11-27)


### Features

* list one command per line in /help, with what it does ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* rank omnibox matches like fzf and highlight the matched letters ([1a0b610](https://github.com/agustingianni/honk/commit/1a0b6106395b4cb7d9c14f6119b586d6fc37f6b2))
* rank the omnibox actions you used last first ([1a0b610](https://github.com/agustingianni/honk/commit/1a0b6106395b4cb7d9c14f6119b586d6fc37f6b2))
* run omnibox actions on any server, not only the active one ([1a0b610](https://github.com/agustingianni/honk/commit/1a0b6106395b4cb7d9c14f6119b586d6fc37f6b2))
* say when /history finds no older messages ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* show desktop notifications inside tmux and zellij ([7f046ff](https://github.com/agustingianni/honk/commit/7f046ff3024c9771f72b41965ca0fb4237febe3c))
* show invites to a channel ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* show server replies and errors in plain words ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))


### Bug Fixes

* mark a message as not sent when the server refuses it ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* play back history without HistServ lines on Ergo servers ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* remove mIRC color codes from system lines such as the MOTD ([5c02c5b](https://github.com/agustingianni/honk/commit/5c02c5b3d1299104379d121a529bbc442b58ea58))
* say what is wrong with a broken config file, not show a stack trace ([d79d27c](https://github.com/agustingianni/honk/commit/d79d27c9e9ee777ee23c7c25e0e52615ac4f9873))
* show that someone is away once per DM, not on every message ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
* try another nick when the network holds yours (437) ([7f833a4](https://github.com/agustingianni/honk/commit/7f833a424ddfff27158f6a47dbe9adbac33eece9))
