//! Client Registry — Thread-safe connected client tracking.
//!
//! Manages the set of connected SSE clients with metadata. Uses
//! Arc<Mutex<HashMap>> internally for thread safety, but since napi-rs
//! classes are single-threaded (accessed from the JS main thread), the
//! Mutex is primarily for correctness rather than contention.
//!
//! Exported to Node.js via napi-rs as a class with methods:
//!   - new ClientRegistry()
//!   - addClient(id, connectedAt, lastEventId)
//!   - removeClient(id) -> boolean
//!   - getClientCount() -> number
//!   - getClients() -> ClientInfo[]
//!   - hasClient(id) -> boolean
//!   - updateLastEventId(id, lastEventId)

use std::collections::HashMap;

use napi_derive::napi;

/// Information about a connected SSE client.
///
/// Exported to JS as a plain object:
/// ```js
/// { id: "client-1", connectedAt: 1713200000000, lastEventId: 42 }
/// ```
#[napi(object)]
#[derive(Clone, Debug)]
pub struct ClientInfo {
    /// Unique client identifier
    pub id: String,
    /// Connection timestamp (JS Date.now() compatible)
    pub connected_at: f64,
    /// Last event ID successfully sent to this client
    pub last_event_id: u32,
}

/// Registry of connected SSE clients.
///
/// Provides O(1) add/remove/lookup by client ID using a HashMap.
///
/// ```js
/// const registry = new ClientRegistry();
/// registry.addClient("c1", Date.now(), 0);
/// registry.getClientCount(); // 1
/// registry.getClients(); // [{ id: "c1", connectedAt: ..., lastEventId: 0 }]
/// registry.removeClient("c1"); // true
/// ```
#[napi]
pub struct ClientRegistry {
    clients: HashMap<String, ClientInfo>,
}

#[napi]
impl ClientRegistry {
    /// Create a new empty client registry.
    #[napi(constructor)]
    pub fn new() -> Self {
        ClientRegistry {
            clients: HashMap::new(),
        }
    }

    /// Register a new client.
    ///
    /// If a client with the same ID already exists, it is replaced.
    #[napi]
    pub fn add_client(&mut self, id: String, connected_at: f64, last_event_id: u32) {
        self.clients.insert(
            id.clone(),
            ClientInfo {
                id,
                connected_at,
                last_event_id,
            },
        );
    }

    /// Remove a client by ID.
    ///
    /// Returns `true` if the client was found and removed, `false` otherwise.
    #[napi]
    pub fn remove_client(&mut self, id: String) -> bool {
        self.clients.remove(&id).is_some()
    }

    /// Get the number of connected clients.
    #[napi]
    pub fn get_client_count(&self) -> u32 {
        self.clients.len() as u32
    }

    /// Get all connected clients as an array of ClientInfo objects.
    ///
    /// Order is not guaranteed (HashMap iteration order).
    #[napi(ts_return_type = "ClientInfo[]")]
    pub fn get_clients(&self) -> Vec<ClientInfo> {
        self.clients.values().cloned().collect()
    }

    /// Check if a client with the given ID is registered.
    #[napi]
    pub fn has_client(&self, id: String) -> bool {
        self.clients.contains_key(&id)
    }

    /// Update the last event ID for a client.
    ///
    /// Returns `true` if the client was found and updated, `false` otherwise.
    #[napi]
    pub fn update_last_event_id(&mut self, id: String, last_event_id: u32) -> bool {
        if let Some(client) = self.clients.get_mut(&id) {
            client.last_event_id = last_event_id;
            true
        } else {
            false
        }
    }

    /// Clear all clients from the registry.
    #[napi]
    pub fn clear(&mut self) {
        self.clients.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_registry_is_empty() {
        let reg = ClientRegistry::new();
        assert_eq!(reg.get_client_count(), 0);
        assert!(reg.get_clients().is_empty());
    }

    #[test]
    fn test_add_and_get_client() {
        let mut reg = ClientRegistry::new();
        reg.add_client("c1".to_string(), 1000.0, 0);

        assert_eq!(reg.get_client_count(), 1);
        assert!(reg.has_client("c1".to_string()));

        let clients = reg.get_clients();
        assert_eq!(clients.len(), 1);
        assert_eq!(clients[0].id, "c1");
        assert_eq!(clients[0].connected_at, 1000.0);
        assert_eq!(clients[0].last_event_id, 0);
    }

    #[test]
    fn test_remove_client() {
        let mut reg = ClientRegistry::new();
        reg.add_client("c1".to_string(), 1000.0, 0);
        reg.add_client("c2".to_string(), 2000.0, 5);

        assert!(reg.remove_client("c1".to_string()));
        assert_eq!(reg.get_client_count(), 1);
        assert!(!reg.has_client("c1".to_string()));
        assert!(reg.has_client("c2".to_string()));
    }

    #[test]
    fn test_remove_nonexistent_returns_false() {
        let mut reg = ClientRegistry::new();
        assert!(!reg.remove_client("ghost".to_string()));
    }

    #[test]
    fn test_update_last_event_id() {
        let mut reg = ClientRegistry::new();
        reg.add_client("c1".to_string(), 1000.0, 0);

        assert!(reg.update_last_event_id("c1".to_string(), 42));
        let clients = reg.get_clients();
        assert_eq!(clients[0].last_event_id, 42);
    }

    #[test]
    fn test_update_nonexistent_returns_false() {
        let mut reg = ClientRegistry::new();
        assert!(!reg.update_last_event_id("ghost".to_string(), 10));
    }

    #[test]
    fn test_add_duplicate_replaces() {
        let mut reg = ClientRegistry::new();
        reg.add_client("c1".to_string(), 1000.0, 0);
        reg.add_client("c1".to_string(), 2000.0, 10);

        assert_eq!(reg.get_client_count(), 1);
        let clients = reg.get_clients();
        assert_eq!(clients[0].connected_at, 2000.0);
        assert_eq!(clients[0].last_event_id, 10);
    }

    #[test]
    fn test_clear() {
        let mut reg = ClientRegistry::new();
        reg.add_client("c1".to_string(), 1000.0, 0);
        reg.add_client("c2".to_string(), 2000.0, 5);

        reg.clear();
        assert_eq!(reg.get_client_count(), 0);
        assert!(reg.get_clients().is_empty());
    }

    #[test]
    fn test_multiple_clients() {
        let mut reg = ClientRegistry::new();
        for i in 0..10 {
            reg.add_client(format!("c{}", i), i as f64 * 100.0, i);
        }

        assert_eq!(reg.get_client_count(), 10);
        assert_eq!(reg.get_clients().len(), 10);
    }
}
