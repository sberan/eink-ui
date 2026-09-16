use eink_core::{Damage, Kind, Mode, Scene, SCREEN_H, SCREEN_W};

fn save(scene: &Scene, name: &str) {
    let path = format!("{}/{name}", env!("CARGO_MANIFEST_DIR"));
    let f = std::fs::File::create(&path).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(f), SCREEN_W, SCREEN_H);
    enc.set_color(png::ColorType::Grayscale);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(scene.fb()).unwrap();
}

#[test]
fn todo_list_layout_and_partial_damage() {
    let mut s = Scene::new();
    let root = s.create(Kind::Box);
    s.set_props(root, r#"{"style":{"width":1072,"height":1448,"padding":[48,56,36,56]},"bg":255}"#).unwrap();
    let header = s.create(Kind::Box);
    s.set_props(header, r#"{"style":{"flex_direction":"row","justify_content":"space-between","align_items":"end","padding":[0,0,10,0]}}"#).unwrap();
    let day = s.create(Kind::Text);
    s.set_props(day, r#"{"text":"Tuesday","font_size":64,"bold":true}"#).unwrap();
    let md = s.create(Kind::Text);
    s.set_props(md, r#"{"text":"Sep 15","font_size":40,"bold":true}"#).unwrap();
    s.append(header, day);
    s.append(header, md);
    let rule = s.create(Kind::Box);
    s.set_props(rule, r#"{"style":{"height":4},"bg":0}"#).unwrap();
    s.append(root, header);
    s.append(root, rule);
    let mut rows = Vec::new();
    for (i, t) in ["10:30 Enterprise Standup + Video Project Sync", "11:00 Sam / Renzo 1:1", "A long item that should wrap onto a second line because the panel is only so wide"].iter().enumerate() {
        let row = s.create(Kind::Box);
        s.set_props(row, r#"{"style":{"flex_direction":"row","align_items":"center","gap":22,"margin":[8,0,0,0]},"hit":true}"#).unwrap();
        let cb = s.create(Kind::Box);
        s.set_props(cb, &format!(r#"{{"style":{{"width":30,"height":30}},"border":3,"bg":{}}}"#, if i == 1 { 0 } else { 255 })).unwrap();
        let tx = s.create(Kind::Text);
        s.set_props(tx, &format!(r#"{{"text":"{t}","font_size":32,"style":{{"flex_shrink":1}}}}"#)).unwrap();
        s.append(row, cb);
        s.append(row, tx);
        s.append(root, row);
        rows.push((row, cb, tx));
    }
    s.set_root(root);
    let d = s.commit();
    assert_eq!(d.len(), 1, "first commit is a full refresh");
    assert_eq!(d[0].mode, Mode::Gc16);
    save(&s, "test_full.png");

    // toggle the first checkbox: only that row's area should be damaged, with a DU update
    s.set_props(rows[0].1, r#"{"bg":0}"#).unwrap();
    s.set_props(rows[0].2, r#"{"color":120}"#).unwrap();
    let d: Vec<Damage> = s.commit();
    assert!(!d.is_empty());
    assert!(d.iter().all(|x| x.mode == Mode::Du));
    let total: i64 = d.iter().map(|x| x.rect.area()).sum();
    assert!(total < (SCREEN_W as i64 * SCREEN_H as i64) / 10, "partial damage too large: {total}");
    println!("partial damage: {:?}", d.iter().map(|x| x.rect).collect::<Vec<_>>());
    save(&s, "test_partial.png");

    // hit test lands on the row
    let r = s.hit(300, 240);
    assert!(rows.iter().any(|(row, _, _)| *row == r), "hit {r}");
    // nothing changed -> no damage
    assert!(s.commit().is_empty());
}
