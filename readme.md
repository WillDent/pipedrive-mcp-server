# Pipedrive MCP Server

This is a Model Context Protocol (MCP) server that connects to the Pipedrive API v2. It allows you to expose Pipedrive data and functionality to LLM applications like Claude.

## Features

- Read-only access to Pipedrive data
- Exposes deals, persons, organizations, and pipelines
- Includes all fields including custom fields
- Predefined prompts for common operations

## Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file in the root directory with your Pipedrive API token:
   ```
   PIPEDRIVE_API_TOKEN=your_api_token_here
   ```
4. Build the project:
   ```
   npm run build
   ```
5. Start the server:
   ```
   npm start
   ```

## Using with Claude

To use this server with Claude for Desktop:

1. Configure Claude for Desktop by editing your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pipedrive": {
      "command": "node",
      "args": ["/path/to/pipedrive-mcp-server/build/index.js"],
      "env": {
        "PIPEDRIVE_API_TOKEN": "your_api_token_here"
      }
    }
  }
}
```

2. Restart Claude for Desktop
3. In the Claude application, you should now see the Pipedrive tools available

## Available Tools

- `get-deals`: Get all deals from Pipedrive (including custom fields)
- `get-deal`: Get a specific deal by ID (including custom fields)
- `search-deals`: Search deals by term
- `get-persons`: Get all persons from Pipedrive (including custom fields)
- `get-person`: Get a specific person by ID (including custom fields)
- `search-persons`: Search persons by term
- `get-organizations`: Get all organizations from Pipedrive (including custom fields)
- `get-organization`: Get a specific organization by ID (including custom fields)
- `search-organizations`: Search organizations by term
- `get-pipelines`: Get all pipelines from Pipedrive
- `get-pipeline`: Get a specific pipeline by ID
- `get-stages`: Get all stages from all pipelines
- `search-leads`: Search leads by term
- `search-all`: Search across all item types (deals, persons, organizations, etc.)

## Available Prompts

- `list-all-deals`: List all deals in Pipedrive
- `list-all-persons`: List all persons in Pipedrive
- `list-all-pipelines`: List all pipelines in Pipedrive
- `analyze-deals`: Analyze deals by stage
- `analyze-contacts`: Analyze contacts by organization
- `analyze-leads`: Analyze leads by status
- `compare-pipelines`: Compare different pipelines and their stages
- `find-high-value-deals`: Find high-value deals

## License

MIT
