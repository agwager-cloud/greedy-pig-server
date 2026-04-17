import express from "express";
import http from "http";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { monitor } from "@colyseus/monitor";
import cors from "cors";
import { GreedyPigRoom } from "./rooms/GreedyPigRoom.js";

const port = Number(process.env.PORT || 2567);
const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Greedy Pig server is running");
});

app.use("/colyseus", monitor());

const server = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server,
  }),
});

gameServer.define("greedy_pig", GreedyPigRoom);

// IMPORTANT: let Colyseus start listening here
gameServer.listen(port);

console.log(`Greedy Pig server listening on http://localhost:${port}`);
