import { Room, Client } from "@colyseus/core";
import { GreedyPigPlayer } from "../schema/GreedyPigPlayer.js";
import { GreedyPigState } from "../schema/GreedyPigState.js";

import { generateRoomCode } from "../utils/roomCode.js";
import {
  areAllPlayersDoneForRound,
  getExpectedSubmittedTotal,
  isKnockoutRoll,
} from "../utils/rules.js";

type UpdateSettingsPayload = {
  mode?: "rounds" | "points";
  roundsToPlay?: number;
  pointsGoal?: number;
  diceCount?: number;
  diceSides?: 6 | 8 | 10 | 12 | 20;
  knockoutNumbers?: number[];
  safeRollsEnabled?: boolean;
  multiplierEnabled?: boolean;
};

type JoinOptions = {
  name?: string;
  isHost?: boolean;
  roomCode?: string;
  deviceId?: string;
};

type HostRollResultPayload = {
  die1: number;
  die2?: number;
  diceCount: number;
  diceSides: 6 | 8 | 10 | 12 | 20;
};

type KickPlayerPayload = {
  sessionId?: string;
  name?: string;
};

type AllowPlayerNamePayload = {
  name?: string;
};

export class GreedyPigRoom extends Room {
  declare state: GreedyPigState;
  maxClients = 40;

  private blockedNames = new Set<string>();
  private kickedSessionIds = new Set<string>();
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;
  private rollFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly decisionWindowMs = 15_000;

  onCreate() {
    this.setState(new GreedyPigState());
    this.state.roomCode = generateRoomCode(4);

    this.setMetadata({
      roomCode: this.state.roomCode,
    });

    this.state.settings.knockoutNumbers.push(2);

    this.onMessage("request_manage_players_data", (client) => {
      if (client.sessionId !== this.state.hostSessionId) return;

      const connected: { name: string; sessionId: string }[] = [];
      const disconnected: { name: string; sessionId: string }[] = [];

      for (const player of this.state.players.values()) {
        if (!player || player.isHost) continue;

        const item = {
          name: player.name,
          sessionId: player.sessionId,
        };

        if (player.isConnected === false) {
          disconnected.push(item);
        } else {
          connected.push(item);
        }
      }

      connected.sort((a, b) => a.name.localeCompare(b.name));
      disconnected.sort((a, b) => a.name.localeCompare(b.name));

      client.send("manage_players_data", {
        connected,
        disconnected,
        banned: [...this.blockedNames].sort((a, b) => a.localeCompare(b)),
      });
    });

    this.onMessage(
      "update_settings",
      (client, payload: UpdateSettingsPayload) => {
        if (client.sessionId !== this.state.hostSessionId) return;
        if (this.state.phase !== "lobby") return;

        if (payload.mode) this.state.settings.mode = payload.mode;
        if (typeof payload.roundsToPlay === "number") {
          this.state.settings.roundsToPlay = Math.max(1, payload.roundsToPlay);
        }
        if (typeof payload.pointsGoal === "number") {
          this.state.settings.pointsGoal = Math.max(1, payload.pointsGoal);
        }
        if (typeof payload.diceCount === "number") {
          this.state.settings.diceCount = Math.max(
            1,
            Math.min(2, payload.diceCount),
          );
        }
        if (typeof payload.diceSides === "number") {
          this.state.settings.diceSides = payload.diceSides;
        }

        if (typeof payload.safeRollsEnabled === "boolean") {
          this.state.settings.safeRollsEnabled = payload.safeRollsEnabled;
        }

        if (typeof payload.multiplierEnabled === "boolean") {
          this.state.settings.multiplierEnabled = payload.multiplierEnabled;
        }

        if (
          Array.isArray(payload.knockoutNumbers) &&
          payload.knockoutNumbers.length > 0
        ) {
          this.state.settings.knockoutNumbers.clear();
          payload.knockoutNumbers.forEach((n) => {
            this.state.settings.knockoutNumbers.push(n);
          });
        }
        const defaultKo = this.getDefaultKnockoutNumbers(
          this.state.settings.diceCount,
          this.state.settings.diceSides,
        );

        const currentKo = [...this.state.settings.knockoutNumbers];
        const maxKoValue =
          this.state.settings.diceCount === 2
            ? this.state.settings.diceSides * 2
            : this.state.settings.diceSides;

        const hasInvalidKo =
          currentKo.length === 0 ||
          currentKo.some((n) => n < 1 || n > maxKoValue);

        if (hasInvalidKo) {
          this.state.settings.knockoutNumbers.clear();
          defaultKo.forEach((n) => this.state.settings.knockoutNumbers.push(n));
        }
      },
    );
    this.onMessage("start_game", (client) => {
      if (client.sessionId !== this.state.hostSessionId) return;
      if (this.state.phase !== "lobby") return;
      this.startGame();
    });

    this.onMessage("roll_die", (client) => {
      // Legacy/manual fallback only. The normal game flow now rolls automatically
      // after the server-controlled countdown reaches zero.
      if (client.sessionId !== this.state.hostSessionId) return;
      if (this.state.phase !== "awaiting_roll") return;

      this.triggerAutomaticRoll();
    });

    this.onMessage(
      "host_roll_result",
      (client, payload: HostRollResultPayload) => {
        if (client.sessionId !== this.state.hostSessionId) return;
        if (this.state.phase !== "rolling_animation") return;
        if (!payload) return;

        const diceCount = Number(payload.diceCount ?? 1);
        const diceSides = Number(
          payload.diceSides ?? this.state.settings.diceSides ?? 6,
        );

        const die1 = Number(payload.die1 ?? 0);
        const die2 = diceCount === 2 ? Number(payload.die2 ?? 0) : null;

        if (!Number.isInteger(die1) || die1 < 1 || die1 > diceSides) return;

        if (diceCount === 2) {
          if (
            !Number.isInteger(die2) ||
            (die2 ?? 0) < 1 ||
            (die2 ?? 0) > diceSides
          ) {
            return;
          }
        }

        this.clearRollFallbackTimer();
        this.applyHostResolvedRoll(die1, die2, diceCount, diceSides);
      },
    );

    this.onMessage("submit_total", (client, submittedTotal: number) => {
      if (this.state.phase !== "awaiting_answers") return;

      const player = this.state.players.get(client.sessionId);
      if (!player || player.hasSaved || player.isBusted) return;
      if (player.hasAnsweredThisRoll) return;

      const expected = getExpectedSubmittedTotal(
        player,
        this.state.currentRoll,
        this.state.settings.multiplierEnabled,
        this.state.currentRound,
      );

      if (submittedTotal === expected) {
        player.roundSubtotal = submittedTotal;
        player.hasAnsweredThisRoll = true;
        client.send("correct_total", { submittedTotal });

        this.checkForRoundEnd();
      } else {
        const multiplierEnabled = this.state.settings.multiplierEnabled;
        const currentRound = this.state.currentRound;

        let expectedHint = "Try again";

        if (multiplierEnabled && currentRound > 1) {
          const unmultipliedGuess =
            player.roundSubtotal + this.state.currentRoll;

          if (submittedTotal === unmultipliedGuess) {
            expectedHint = "Incorrect. Please add the round multiplier.";
          } else {
            expectedHint = `Incorrect. Round ${currentRound} uses ×${currentRound}. Try again.`;
          }
        } else {
          expectedHint = "Incorrect total. Try again.";
        }

        client.send("incorrect_total", { expectedHint });
      }
    });
    this.onMessage("save_round", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      if (
        this.state.phase !== "awaiting_answers" &&
        this.state.phase !== "awaiting_roll"
      )
        return;
      if (player.hasSaved || player.isBusted) return;
      if (!player.hasAnsweredThisRoll) return;

      player.hasSaved = true;
      player.bankedScore += player.roundSubtotal;

      client.send("round_saved", {
        roundSubtotal: player.roundSubtotal,
        bankedScore: player.bankedScore,
      });

      this.checkForRoundEnd();
    });

    this.onMessage("next_round", (client) => {
      if (client.sessionId !== this.state.hostSessionId) return;
      if (this.state.phase !== "round_summary") return;

      if (this.isGameOver()) {
        this.state.phase = "game_over";
        this.broadcast("game_over", {});
        return;
      }

      this.state.currentRound += 1;
      this.state.currentRoll = 0;
      this.state.rollCountThisRound = 0;
      this.resetRoundFlags();

      this.broadcast("round_started", { round: this.state.currentRound });
      this.startRollCountdown();
    });

    this.onMessage("play_again", (client) => {
      if (client.sessionId !== this.state.hostSessionId) return;
      this.resetForNewGame(false);
    });

    this.onMessage("return_to_lobby", (client) => {
      if (client.sessionId !== this.state.hostSessionId) return;
      this.returnToLobby();
    });

    this.onMessage("kick_player", (client, payload: KickPlayerPayload) => {
      if (client.sessionId !== this.state.hostSessionId) return;
      if (!payload?.sessionId) return;
      if (payload.sessionId === this.state.hostSessionId) return;

      this.kickStudentBySessionId(
        payload.sessionId,
        "That name is not allowed. Please change your name and rejoin.",
      );
    });

    this.onMessage(
      "allow_player_name",
      (client, payload: AllowPlayerNamePayload) => {
        if (client.sessionId !== this.state.hostSessionId) return;
        if (!payload?.name) return;

        this.allowPlayerName(payload.name);
      },
    );
  }

  private normalizePlayerName(name?: string): string {
    return (
      (name || "Player").trim().replace(/\s+/g, " ").slice(0, 10) || "Player"
    );
  }

  private isNameBlocked(name: string): boolean {
    return this.blockedNames.has(this.normalizePlayerName(name));
  }

  public getBlockedNames(): string[] {
    return [...this.blockedNames].sort((a, b) => a.localeCompare(b));
  }

  private findClientBySessionId(sessionId: string): Client | null {
    for (const client of this.clients) {
      if (client.sessionId === sessionId) return client;
    }
    return null;
  }

  private kickStudentBySessionId(sessionId: string, reason: string): void {
    const player = this.state.players.get(sessionId);
    if (!player) return;
    if (player.isHost) return;

    const normalizedName = this.normalizePlayerName(player.name);
    this.blockedNames.add(normalizedName);

    const targetClient = this.findClientBySessionId(sessionId);

    if (targetClient) {
      this.kickedSessionIds.add(sessionId);
      targetClient.send("kicked_from_room", {
        reason,
      });
      targetClient.leave(4004, reason);
      return;
    }

    // Fallback if they are already disconnected but still in state.
    if (this.state.players.has(sessionId)) {
      this.state.players.delete(sessionId);
    }

    if (
      this.state.phase === "awaiting_answers" ||
      this.state.phase === "awaiting_roll"
    ) {
      this.checkForRoundEnd();
    }
  }

  private allowPlayerName(name?: string): void {
    const normalizedName = this.normalizePlayerName(name);

    if (!normalizedName) return;

    this.blockedNames.delete(normalizedName);
  }

  private shouldJoinCurrentRound(): boolean {
    return (
      this.state.phase === "lobby" ||
      this.state.phase === "awaiting_roll" ||
      this.state.phase === "round_summary"
    );
  }

  private findDisconnectedStudentByName(name: string): GreedyPigPlayer | null {
    for (const player of this.state.players.values()) {
      if (!player) continue;
      if (player.isHost) continue;
      if (player.isConnected) continue;
      if (player.name === name) return player;
    }
    return null;
  }

  private reattachDisconnectedPlayer(
    oldPlayer: GreedyPigPlayer,
    newSessionId: string,
  ) {
    const oldSessionId = oldPlayer.sessionId;

    if (oldSessionId && this.state.players.has(oldSessionId)) {
      this.state.players.delete(oldSessionId);
    }

    oldPlayer.sessionId = newSessionId;
    oldPlayer.isConnected = true;

    this.state.players.set(newSessionId, oldPlayer);
  }

  onJoin(client: Client, options: JoinOptions) {
    const requestedRoomCode = (options.roomCode || "")
      .trim()
      .toUpperCase()
      .slice(0, 4);

    const cleanName = this.normalizePlayerName(options.name);
    const isHost = !!options.isHost;
    const deviceId = this.normalizeDeviceId(options.deviceId);

    if (!isHost) {
      if (requestedRoomCode !== this.state.roomCode) {
        client.leave(4001, "Invalid room code");
        return;
      }
    }

    if (!isHost && this.isNameBlocked(cleanName)) {
      client.leave(
        4004,
        "That name is not allowed. Please choose a different name.",
      );
      return;
    }

    if (isHost) {
      const player = new GreedyPigPlayer();
      player.sessionId = client.sessionId;
      player.name = cleanName;
      player.isHost = true;
      player.isConnected = true;
      player.activeThisRound = true;

      if (!this.state.hostSessionId) {
        this.state.hostSessionId = client.sessionId;
      }

      this.state.players.set(client.sessionId, player);
      return;
    }

    // Try to reconnect to a previously disconnected student with the same name
    const existingDisconnectedPlayer =
      this.findDisconnectedStudentByName(cleanName);

    if (existingDisconnectedPlayer) {
      this.reattachDisconnectedPlayer(
        existingDisconnectedPlayer,
        client.sessionId,
      );

      existingDisconnectedPlayer.justRejoined = true;

      if (this.state.phase === "awaiting_answers") {
        existingDisconnectedPlayer.activeThisRound = false;
        existingDisconnectedPlayer.waitingForNextRound = true;
        existingDisconnectedPlayer.hasAnsweredThisRoll = true;
        existingDisconnectedPlayer.hasSaved = false;
        existingDisconnectedPlayer.isBusted = false;
        existingDisconnectedPlayer.roundSubtotal = 0;
        existingDisconnectedPlayer.rollsThisRound = 0;

        this.checkForRoundEnd();
        return;
      }

      existingDisconnectedPlayer.waitingForNextRound =
        existingDisconnectedPlayer.activeThisRound === false;

      return;
    }

    // ADD DEVICE CHECK HERE
    if (!isHost && deviceId) {
      const existingDevicePlayer =
        this.findConnectedStudentByDeviceId(deviceId);

      if (existingDevicePlayer) {
        client.leave(4005, "Only one player can join from this device.");
        return;
      }
    }

    if (!isHost) {
      const existingConnectedPlayer =
        this.findConnectedStudentByName(cleanName);

      if (existingConnectedPlayer) {
        client.leave(4003, "That name is already in use");
        return;
      }
    }

    // Brand new student join
    const player = new GreedyPigPlayer();
    player.sessionId = client.sessionId;
    player.name = cleanName;
    (player as any).deviceId = deviceId;
    player.isHost = false;
    player.isConnected = true;
    player.activeThisRound = this.shouldJoinCurrentRound();
    player.justRejoined = false;
    player.waitingForNextRound = !player.activeThisRound;

    // If joining mid-round, they must not interfere with current round logic
    if (!player.activeThisRound) {
      player.hasAnsweredThisRoll = true;
      player.hasSaved = false;
      player.isBusted = false;
      player.roundSubtotal = 0;
      player.rollsThisRound = 0;
    }

    this.state.players.set(client.sessionId, player);
  }

  onLeave(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    if (client.sessionId === this.state.hostSessionId) {
      this.disconnect();
      return;
    }

    const wasKicked = this.kickedSessionIds.has(client.sessionId);

    if (wasKicked) {
      this.kickedSessionIds.delete(client.sessionId);

      if (this.state.players.has(client.sessionId)) {
        this.state.players.delete(client.sessionId);
      }
    } else {
      player.isConnected = false;
    }

    if (
      this.state.phase === "awaiting_answers" ||
      this.state.phase === "awaiting_roll"
    ) {
      this.checkForRoundEnd();
    }
  }

  private normalizeDeviceId(deviceId?: string): string {
    return (deviceId || "").trim().slice(0, 80);
  }

  private findConnectedStudentByDeviceId(
    deviceId: string,
  ): GreedyPigPlayer | null {
    if (!deviceId) return null;

    for (const player of this.state.players.values()) {
      if (!player) continue;
      if (player.isHost) continue;
      if (player.isConnected === false) continue;
      if ((player as any).deviceId === deviceId) return player;
    }

    return null;
  }

  private returnToLobby() {
    this.resetForNewGame(true);
  }

  private getDefaultKnockoutNumbers(
    diceCount: number,
    diceSides: number,
  ): number[] {
    if (diceCount === 2) {
      if (diceSides === 6) return [7];
      if (diceSides === 8) return [9];
      if (diceSides === 10) return [11];
      if (diceSides === 12) return [13];
      if (diceSides === 20) return [21];
      return [7];
    }

    if (diceSides === 6) return [2];
    if (diceSides === 8) return [2];
    if (diceSides === 10) return [2];
    if (diceSides === 12) return [2];
    if (diceSides === 20) return [2, 5, 10, 15];

    return [2];
  }

  private buildRollMessage(
    die1: number,
    die2: number | null,
    diceCount: number,
    diceSides: number,
    safe: boolean,
  ) {
    return {
      roll: diceCount === 2 ? die1 + (die2 ?? 0) : die1,
      die1,
      die2: die2 ?? undefined,
      diceCount,
      diceSides,
      safe,
    };
  }

  private clearCountdownTimer() {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private clearRollFallbackTimer() {
    if (this.rollFallbackTimer) {
      clearTimeout(this.rollFallbackTimer);
      this.rollFallbackTimer = null;
    }
  }

  private clearCountdownState() {
    this.state.rollCountdownEndsAt = 0;
    this.state.rollCountdownDurationMs = 0;
  }

  private hasAnyPlayerStillPlayingRound(): boolean {
    for (const player of this.state.players.values()) {
      if (!player) continue;
      if (player.isConnected === false) continue;
      if (player.activeThisRound === false) continue;
      if (player.hasSaved || player.isBusted) continue;
      return true;
    }

    return false;
  }

  private startRollCountdown() {
    this.clearCountdownTimer();
    this.clearRollFallbackTimer();

    if (this.state.phase === "game_over" || this.state.phase === "round_summary") {
      this.clearCountdownState();
      return;
    }

    if (!this.hasAnyPlayerStillPlayingRound()) {
      this.clearCountdownState();
      this.checkForRoundEnd();
      return;
    }

    this.state.phase = "awaiting_roll";
    this.state.rollCountdownDurationMs = this.decisionWindowMs;
    this.state.rollCountdownEndsAt = Date.now() + this.decisionWindowMs;

    this.broadcast("roll_countdown_started", {
      round: this.state.currentRound,
      durationMs: this.decisionWindowMs,
      endsAt: this.state.rollCountdownEndsAt,
    });

    this.countdownTimer = setTimeout(() => {
      this.countdownTimer = null;
      this.triggerAutomaticRoll();
    }, this.decisionWindowMs);
  }

  private startAnswerCountdown() {
    this.clearCountdownTimer();

    if (this.state.phase !== "awaiting_answers") {
      this.clearCountdownState();
      return;
    }

    if (!this.hasAnyPlayerStillPlayingRound()) {
      this.clearCountdownState();
      this.checkForRoundEnd();
      return;
    }

    this.state.rollCountdownDurationMs = this.decisionWindowMs;
    this.state.rollCountdownEndsAt = Date.now() + this.decisionWindowMs;

    this.broadcast("answer_countdown_started", {
      round: this.state.currentRound,
      durationMs: this.decisionWindowMs,
      endsAt: this.state.rollCountdownEndsAt,
      currentRoll: this.state.currentRoll,
    });

    this.countdownTimer = setTimeout(() => {
      this.countdownTimer = null;
      this.handleAnswerCountdownExpired();
    }, this.decisionWindowMs);
  }

  private triggerAutomaticRoll() {
    if (this.state.phase !== "awaiting_roll") return;

    this.clearCountdownTimer();
    this.clearCountdownState();

    if (!this.hasAnyPlayerStillPlayingRound()) {
      this.checkForRoundEnd();
      return;
    }

    this.startRollAnimation();
  }

  private startRollAnimation() {
    this.clearCountdownTimer();
    this.clearCountdownState();
    this.clearRollFallbackTimer();

    if (!this.hasAnyPlayerStillPlayingRound()) {
      this.checkForRoundEnd();
      return;
    }

    this.state.phase = "rolling_animation";

    const diceCount = Number(this.state.settings.diceCount ?? 1);
    const diceSides = Number(this.state.settings.diceSides ?? 6) as 6 | 8 | 10 | 12 | 20;

    this.broadcast("host_roll_requested", {
      diceCount,
      diceSides,
    });

    this.rollFallbackTimer = setTimeout(() => {
      if (this.state.phase !== "rolling_animation") return;

      const die1 = Math.floor(Math.random() * diceSides) + 1;
      const die2 = diceCount === 2 ? Math.floor(Math.random() * diceSides) + 1 : null;
      this.applyHostResolvedRoll(die1, die2, diceCount, diceSides);
    }, 12_000);
  }

  private handleAnswerCountdownExpired() {
    if (this.state.phase !== "awaiting_answers") return;

    this.clearCountdownTimer();
    this.clearCountdownState();

    for (const player of this.state.players.values()) {
      if (!player) continue;
      if (player.isConnected === false || !player.activeThisRound) continue;
      if (player.hasSaved || player.isBusted) continue;
      if (player.hasAnsweredThisRoll) continue;

      player.hasSaved = true;
      player.hasAnsweredThisRoll = true;
      player.bankedScore += player.roundSubtotal;

      const client = this.findClientBySessionId(player.sessionId);
      client?.send("auto_saved", {
        roundSubtotal: player.roundSubtotal,
        bankedScore: player.bankedScore,
      });
    }

    if (!this.hasAnyPlayerStillPlayingRound()) {
      this.checkForRoundEnd();
      return;
    }

    this.startRollAnimation();
  }

  private startGame() {
    this.state.currentRound = 1;
    this.state.currentRoll = 0;
    this.state.rollCountThisRound = 0;
    this.resetRoundFlags();
    this.broadcast("round_started", { round: this.state.currentRound });
    this.startRollCountdown();
  }

  private applyHostResolvedRoll(
    die1: number,
    die2: number | null,
    diceCount: number,
    diceSides: number,
  ) {
    this.clearRollFallbackTimer();
    this.clearCountdownTimer();
    this.clearCountdownState();

    const total = diceCount === 2 ? die1 + (die2 ?? 0) : die1;

    this.state.currentRoll = total;
    this.state.rollCountThisRound += 1;

    for (const player of this.state.players.values()) {
      if (player.isConnected === false || !player.activeThisRound) continue;
      if (!player.hasSaved && !player.isBusted) {
        player.rollsThisRound += 1;
      }
    }

    const knockoutHit = isKnockoutRoll(this.state);
    let bustedAnyone = false;
    let safeAnyone = false;

    if (knockoutHit) {
      for (const player of this.state.players.values()) {
        if (player.isConnected === false || !player.activeThisRound) continue;
        if (player.hasSaved || player.isBusted) continue;

        const isSafeRoll =
          this.state.settings.safeRollsEnabled && player.rollsThisRound <= 2;

        if (isSafeRoll) {
          player.hasAnsweredThisRoll = false;
          safeAnyone = true;
          continue;
        }

        player.roundSubtotal = 0;
        player.isBusted = true;
        player.hasAnsweredThisRoll = true;
        bustedAnyone = true;
      }

      this.state.phase = "awaiting_answers";

      const payload = this.buildRollMessage(
        die1,
        die2,
        diceCount,
        diceSides,
        false,
      );

      if (bustedAnyone) {
        this.broadcast("round_knockout", payload);
      } else {
        this.broadcast(
          "roll_result",
          this.buildRollMessage(die1, die2, diceCount, diceSides, safeAnyone),
        );
      }

      this.startAnswerCountdown();
      return;
    }

    for (const player of this.state.players.values()) {
      if (player.isConnected === false || !player.activeThisRound) continue;

      if (!player.hasSaved && !player.isBusted) {
        player.hasAnsweredThisRoll = false;
      }
    }

    this.state.phase = "awaiting_answers";
    this.broadcast(
      "roll_result",
      this.buildRollMessage(die1, die2, diceCount, diceSides, false),
    );

    this.startAnswerCountdown();
  }

  private checkForRoundEnd() {
    if (!areAllPlayersDoneForRound(this.state)) {
      return;
    }

    this.clearCountdownTimer();
    this.clearRollFallbackTimer();
    this.clearCountdownState();

    this.state.phase = "round_summary";

    const isFinalRound = this.isGameOver();

    this.broadcast("round_ended", {
      round: this.state.currentRound,
      isFinalRound,
    });
  }

  private findConnectedStudentByName(name: string): GreedyPigPlayer | null {
    for (const player of this.state.players.values()) {
      if (!player) continue;
      if (player.isHost) continue;
      if (player.isConnected === false) continue;
      if (player.name === name) return player;
    }
    return null;
  }

  private resetRoundFlags() {
    for (const player of this.state.players.values()) {
      if (player.isConnected) {
        player.activeThisRound = true;
      }

      player.roundSubtotal = 0;
      player.rollsThisRound = 0;
      player.hasSaved = false;
      player.isBusted = false;
      player.hasAnsweredThisRoll = false;
      player.justRejoined = false;
      player.waitingForNextRound = false;
    }
  }

  private isGameOver(): boolean {
    if (this.state.settings.mode === "rounds") {
      return this.state.currentRound >= this.state.settings.roundsToPlay;
    }

    if (this.state.settings.mode === "points") {
      for (const player of this.state.players.values()) {
        if (player.bankedScore >= this.state.settings.pointsGoal) {
          return true;
        }
      }
    }

    return false;
  }

  private resetForNewGame(returnToLobby: boolean) {
    for (const player of this.state.players.values()) {
      player.bankedScore = 0;
      player.roundSubtotal = 0;
      player.hasSaved = false;
      player.isBusted = false;
      player.hasAnsweredThisRoll = false;
      player.rollsThisRound = 0;
      player.activeThisRound = true;
    }

    this.clearCountdownTimer();
    this.clearRollFallbackTimer();
    this.clearCountdownState();

    this.state.currentRound = 1;
    this.state.currentRoll = 0;
    this.state.rollCountThisRound = 0;
    this.state.phase = returnToLobby ? "lobby" : "awaiting_roll";

    // Re-validate KO against current settings
    const diceCount = Number(this.state.settings.diceCount ?? 1);
    const diceSides = Number(this.state.settings.diceSides ?? 6);

    const currentKo =
      this.state.settings.knockoutNumbers &&
      typeof this.state.settings.knockoutNumbers[Symbol.iterator] === "function"
        ? Array.from(
            this.state.settings.knockoutNumbers as Iterable<number>,
          ).map((n) => Number(n))
        : [];

    const maxKoValue = diceCount === 2 ? diceSides * 2 : diceSides;
    const hasInvalidKo =
      currentKo.length === 0 ||
      currentKo.some((n) => !Number.isFinite(n) || n < 1 || n > maxKoValue);

    if (hasInvalidKo) {
      this.state.settings.knockoutNumbers.clear();
      const defaults = this.getDefaultKnockoutNumbers(diceCount, diceSides);
      defaults.forEach((n) => this.state.settings.knockoutNumbers.push(n));
    }

    if (returnToLobby) {
      this.broadcast("returned_to_lobby", {});
    } else {
      this.broadcast("round_started", { round: this.state.currentRound });
      this.startRollCountdown();
    }
  }

  onDispose() {
    this.clearCountdownTimer();
    this.clearRollFallbackTimer();
  }
}
