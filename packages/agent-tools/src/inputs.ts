// Generated from apps/api/openapi.json by `pnpm --filter @dastar/agent-tools generate`. Do not edit.

/** Each tool's input: the API's request schema, taken unchanged from the committed document. */
export const INPUT_SCHEMAS = {
  "search_availability": {
    "type": "object",
    "properties": {
      "party_size": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000
      },
      "from": {
        "type": "string",
        "format": "date-time"
      },
      "to": {
        "type": "string",
        "format": "date-time"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 500
      }
    },
    "required": [
      "party_size",
      "from",
      "to"
    ]
  },
  "hold": {
    "type": "object",
    "properties": {
      "party_size": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000
      },
      "starts_at": {
        "type": "string",
        "format": "date-time"
      },
      "duration_minutes": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100000
      },
      "assignment": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": [
              "unit",
              "combo"
            ]
          },
          "id": {
            "type": "string",
            "format": "uuid"
          }
        },
        "required": [
          "kind",
          "id"
        ]
      },
      "external_ref": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    },
    "required": [
      "party_size",
      "starts_at",
      "duration_minutes",
      "assignment"
    ]
  },
  "cancel": {
    "type": "object",
    "properties": {
      "reservation_id": {
        "type": "string",
        "format": "uuid"
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 500
      },
      "expected_version": {
        "type": "integer",
        "minimum": 1,
        "maximum": 2147483647
      }
    },
    "required": [
      "reservation_id",
      "reason"
    ]
  },
  "get_reservation": {
    "type": "object",
    "properties": {
      "reservation_id": {
        "type": "string",
        "format": "uuid"
      }
    },
    "required": [
      "reservation_id"
    ]
  }
} as const;
