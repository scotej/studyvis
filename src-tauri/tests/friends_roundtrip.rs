use rusqlite::Connection;
use studyvis_lib::db::{friends, migrations::run_migrations};

fn setup() -> Connection {
    let mut conn = Connection::open_in_memory().expect("open in-memory");
    run_migrations(&mut conn).expect("run migrations");
    conn
}

#[test]
fn add_then_list_returns_inserted_friend() {
    let conn = setup();
    friends::add(&conn, "ed_sam", "x_sam", "Sam", 1_700_000_000)
        .expect("add friend");
    let listed = friends::list(&conn).expect("list friends");
    assert_eq!(listed.len(), 1);
    let f = &listed[0];
    assert_eq!(f.ed_pubkey_hex, "ed_sam");
    assert_eq!(f.x_pubkey_hex, "x_sam");
    assert_eq!(f.display_name.as_deref(), Some("Sam"));
    assert_eq!(f.paired_at, Some(1_700_000_000));
    assert_eq!(f.last_studied_with, None);
}

#[test]
fn add_is_upsert_on_ed_pubkey_conflict() {
    let conn = setup();
    friends::add(&conn, "ed_sam", "x_sam_old", "Sam", 1_700_000_000)
        .expect("add 1");
    friends::add(&conn, "ed_sam", "x_sam_new", "Sammy", 1_700_000_500)
        .expect("upsert");
    let listed = friends::list(&conn).expect("list");
    assert_eq!(listed.len(), 1, "should not duplicate on ed_pubkey conflict");
    assert_eq!(listed[0].x_pubkey_hex, "x_sam_new");
    assert_eq!(listed[0].display_name.as_deref(), Some("Sammy"));
    assert_eq!(listed[0].paired_at, Some(1_700_000_500));
}

#[test]
fn remove_drops_the_friend() {
    let conn = setup();
    friends::add(&conn, "ed_a", "x_a", "A", 1).expect("add a");
    friends::add(&conn, "ed_b", "x_b", "B", 2).expect("add b");
    let removed = friends::remove(&conn, "ed_a").expect("remove a");
    assert_eq!(removed, 1);
    let listed = friends::list(&conn).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].ed_pubkey_hex, "ed_b");
}

#[test]
fn remove_unknown_friend_is_zero_rows() {
    let conn = setup();
    let removed = friends::remove(&conn, "nope").expect("remove nope");
    assert_eq!(removed, 0);
}

#[test]
fn update_last_studied_writes_the_timestamp() {
    let conn = setup();
    friends::add(&conn, "ed_sam", "x_sam", "Sam", 1_700_000_000)
        .expect("add");
    let touched = friends::update_last_studied(&conn, "ed_sam", 1_700_000_999)
        .expect("update");
    assert_eq!(touched, 1);
    let f = friends::list(&conn).expect("list").remove(0);
    assert_eq!(f.last_studied_with, Some(1_700_000_999));
}

#[test]
fn get_x_pubkey_returns_some_for_known_friend_and_none_for_stranger() {
    let conn = setup();
    friends::add(&conn, "ed_sam", "x_sam_only", "Sam", 1).expect("add");
    let known = friends::get_x_pubkey(&conn, "ed_sam").expect("known");
    assert_eq!(known.as_deref(), Some("x_sam_only"));
    let unknown = friends::get_x_pubkey(&conn, "ed_unknown").expect("unknown");
    assert_eq!(unknown, None);
}

#[test]
fn list_orders_by_paired_at_desc_then_pubkey_asc() {
    let conn = setup();
    friends::add(&conn, "ed_a", "x_a", "A", 100).expect("add a");
    friends::add(&conn, "ed_b", "x_b", "B", 300).expect("add b");
    friends::add(&conn, "ed_c", "x_c", "C", 200).expect("add c");
    let ordered: Vec<String> = friends::list(&conn)
        .expect("list")
        .into_iter()
        .map(|f| f.ed_pubkey_hex)
        .collect();
    assert_eq!(ordered, vec!["ed_b", "ed_c", "ed_a"]);
}
