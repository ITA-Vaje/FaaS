/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

const {onRequest} = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const express = require("express");
const app = express();
app.use(express.json());


admin.initializeApp();

const db = admin.firestore();

exports.registerUser = onRequest(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).send("Email and password are required.");
    return;
  }

  try {
    const userRecord = await admin.auth().createUser({
      email,
      password,
    });
    res.status(201).send({ message: "User created", uid: userRecord.uid });
  } catch (error) {
    logger.error("Error creating user:", error);
    res.status(500).send({ error: error.message });
  }
});

exports.submitPrediction = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

//   const idToken = req.headers.authorization?.split("Bearer ")[1];
//   if (!idToken) {
//     return res.status(401).send("Missing auth token");
//   }

  try {
    // const decodedToken = await admin.auth().verifyIdToken(idToken);
    // const uid = decodedToken.uid;
    const uid = "test-user-223"; // fake user ID
    const { raceId, prediction } = req.body;

    if (!raceId || !prediction || !prediction.p1 || !prediction.p2 || !prediction.p3) {
      return res.status(400).send("Missing raceId or prediction (p1, p2, p3)");
    }

    const docId = `${raceId}_${uid}`;

    await db.collection("predictions").add({
    uid,
    raceId,
    prediction,
    timestamp: new Date().toISOString()
    });

    res.status(200).send({ message: "Prediction submitted successfully" });
  } catch (error) {
    logger.error("Error submitting prediction:", error);
    res.status(500).send({ error: error.message });
  }
});

exports.updateRaceResult = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const { raceId, result } = req.body;

  if (!raceId || !result || !result.p1 || !result.p2 || !result.p3) {
    return res.status(400).send("Missing raceId or result (p1, p2, p3)");
  }

  try {
    await admin.firestore().collection("results").doc(raceId).set({
      result,
      timestamp: new Date().toISOString(),
    });

    res.status(200).send({ message: "Race result updated" });
  } catch (error) {
    logger.error("Error updating race result:", error);
    res.status(500).send({ error: error.message });
  }
});

exports.calculateUserScores = onDocumentWritten("results/{raceId}", async (event) => {
  const raceId = event.params.raceId;
  const afterData = event.data?.after?.data();

  if (!afterData) {
    logger.info(`Result deleted for race: ${raceId}, skipping score calculation.`);
    return;
  }

  const actual = afterData.result;
  logger.info(`Calculating scores for race: ${raceId}`, actual);

  try {
    const predictionsSnapshot = await db.collection("predictions")
      .where("raceId", "==", raceId)
      .get();

    const batch = db.batch();

    predictionsSnapshot.forEach((doc) => {
      const predictionData = doc.data();
      const pred = predictionData.prediction;
      const uid = predictionData.uid;

      let score = 0;
      ["p1", "p2", "p3"].forEach((pos) => {
        if (pred[pos] === actual[pos]) {
          score += 3;
        } else if (Object.values(actual).includes(pred[pos])) {
          score += 1;
        }
      });

      const scoreRef = db.collection("scores").doc(`${uid}_${raceId}`);
      batch.set(scoreRef, {
        uid,
        raceId,
        score,
        timestamp: new Date().toISOString(),
      });
    });

    await batch.commit();
    logger.info(`Scores calculated and saved for race: ${raceId}`);
  } catch (error) {
    logger.error("Error calculating scores:", error);
  }
});

exports.getLeaderboard = onRequest(async (req, res) => {
  try {
    const scoresSnapshot = await db.collection("scores").get();

    const leaderboard = {};

    scoresSnapshot.forEach((doc) => {
      const { uid, score } = doc.data();
      if (!leaderboard[uid]) {
        leaderboard[uid] = 0;
      }
      leaderboard[uid] += score;
    });

    // Convert to array and sort
    const sorted = Object.entries(leaderboard)
      .map(([uid, totalScore]) => ({ uid, totalScore }))
      .sort((a, b) => b.totalScore - a.totalScore);

    res.status(200).send({ leaderboard: sorted });
  } catch (error) {
    logger.error("Error fetching leaderboard:", error);
    res.status(500).send({ error: error.message });
  }
});
