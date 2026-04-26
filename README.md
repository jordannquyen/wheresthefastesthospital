**Where's the Fastest Hospital**, shortened to **WTF-hospital**, is a voice-first routing and automated dispatch system for EMS. Instead of an EMT manually calling around to find an open ER, they simply speak to the app.

1. **Voice-to-Data**: It parses raw EMT speech into structured medical reports.
2. **Intelligent Routing**: It calculates the "Total Time to Care" by combining live traffic with hospital occupancy data.
3. **Automated Handshake**: It handles the "confirmation chain" automatically—requesting a bed from the best-fitting hospital and escalating to the next available one if they don't respond within 60 seconds.

## How we built it
The backbone of the app is a high-speed pipeline of AI and real-time data:
* **Speech Processing**: We used **ElevenLabs** for near-instant speech-to-text and professional-grade readback for confirmation.
* **Medical Intelligence**: **Claude AI (Anthropic)** acts as our "Dispatcher," extracting vitals, demographics, and chief complaints from natural, complicated EMT speech.
* **Routing Engine**: We integrated the **Google Distance Matrix API** for traffic-aware ETAs, **HHS Socrata API** to analyze hospital bed utilization, and local data to find hospital specializations.
