# SADOT Enterprise | Logistics & Dispatch Suite

![Node.js](https://img.shields.io/badge/Node.js-v20+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express.js](https://img.shields.io/badge/Express.js-Backend-000000?style=for-the-badge&logo=express&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-UI-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)
![JSON](https://img.shields.io/badge/Data-JSON_Persistence-gray?style=for-the-badge)

A comprehensive, full-stack administrative platform engineered for municipal logistics, emergency incident management, and workforce oversight. This suite provides a centralized "Command and Control" environment, bridging the gap between public service requests and field-unit execution.

---

## System Architecture

The application follows a **Decoupled Full-Stack Architecture**:
*   **Backend:** A RESTful Node.js/Express API handling data validation, automated Discord telemetry, and persistent state management using a structured JSON flat-file database.
*   **Frontend:** A responsive, performance-optimized SPA (Single Page Application) built with Tailwind CSS and Vanilla JavaScript, ensuring high-speed interactions without framework overhead.
*   **Networking:** Integrated with Nginx for reverse proxying and Cloudflare Tunnels for secure, encrypted external access.

---

## Core Functional Modules

### Central Dispatch & Work Order System
A real-time incident tracking hub that allows citizens to report hazards and staff to manage field responses.
*   **Priority Tiering:** Automated visual indicators for "Routine" vs "Emergency" response codes.
*   **Unit Attachment:** Ability for field operators to "Attach" their callsign to active incidents, establishing a digital trail of responsibility.
*   **Automated Archiving:** Logic-driven cleanup that migrates "Resolved" or "Cancelled" tickets to a historical archive to maintain low-latency live feeds.

### Human Resources & Recruitment Pipeline
An end-to-end hiring management system.
*   **Structured Applications:** Comprehensive 28-point questionnaire capturing technical aptitude and scenario-based reasoning.
*   **Reviewer Console:** Private administrative view for Command Staff to leave internal notes and toggle status (Pending/Approved/Denied).
*   **Automated Onboarding:** Upon approval, the system generates a unique encrypted **Employee Portal Password** and notifies the applicant via a secure Discord Webhook payload.

### Dynamic SOP Knowledge Base
A live-editable digital manual for Standard Operating Procedures.
*   **Content Management:** Admin-only console to update, create, or delete department directives in real-time.
*   **Rich Media Integration:** Support for embedded technical diagrams, geometric staging layouts, and equipment calibration guides.

### Financial Ledger & Asset Tracking
A "State Treasury" simulation providing high-fidelity fiscal oversight.
*   **Automated Payroll:** Dynamically calculates monthly department expenditures based on active roster hours and rank-specific wage tiers.
*   **Asset Valuation:** Live balance sheet tracking HQ real estate and fleet inventory (valued at over $5.5M in simulation).
*   **Operating Burn Rate:** Real-time calculation of fuel consumption, repair costs, and consumable usage (flares, tires, lockout kits).

---

## Advanced Technical Logic

### **The MFO Telemetry Engine**
The **Master Field Operations (MFO)** module features a sophisticated calculation script that simulates real-world vehicle wear:
*   **Fuel Burn Simulation:** Implements a formula `(Distance / 15.0)` to estimate gallon consumption based on in-game mileage.
*   **Resource Depletion Tracking:** Monitors the usage of high-cost items (Tires @ $250/ea) to determine the department's monthly operating margin.

### **Role-Based Access Control (RBAC)**
The system implements a 4-tier security clearance gate:
1.  **Level 1 (Cadet):** Access to SOPs and personal logs.
2.  **Level 2 (Field Op):** Unlocks the Live Dispatch Feed and Work Order attachment.
3.  **Level 3 (Supervisor):** Unlocks the Management Console, Roster Admin, and Finance Ledger.
4.  **Level 4 (Command):** Full system override, Webhook configuration, and Application adjudication.

---

## Integration & API Endpoints

The backend provides a clean API for external services:
*   `POST /api/applications` - Ingests new recruitment packets.
*   `PUT /api/roster/:id` - Administrative updates for personnel.
*   `POST /api/settings/test-webhook` - Validation logic for Discord integration strings.

---

## Installation

1.  **Clone the Repository**
    ```bash
    git clone https://github.com/ChefAsmith/sa-dot.xyz.git
    cd sadot-enterprise/backend
    ```
2.  **Install Dependencies**
    ```bash
    npm install
    ```
4.  **Launch Production**
    ```bash
    node server.js
    ```

---

## License & Maintainer
Distributed under the MIT License. Built with a focus on **extensibility, simulation realism, and administrative efficiency.**

**Maintainer:** *ChefAmbrosia* - Backend & Infrastructure Developer