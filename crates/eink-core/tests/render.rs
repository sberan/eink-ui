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

#[test]
fn markdown_node_toggles_one_row() {
    let mut scene = Scene::new();
    let root = scene.create(Kind::Box);
    scene.set_props(root, r#"{"bg":255,"style":{"width":1072,"height":1448,"padding":36}}"#).unwrap();
    let md = scene.create(Kind::Markdown);
    let text = "# Today\n\n- [ ] one\n- [ ] two\n- [x] three\n\nA paragraph after the list.";
    scene.set_props(md, &format!(r#"{{"text":{},"font_size":30,"hit":true}}"#, serde_json::to_string(text).unwrap())).unwrap();
    scene.append(root, md);
    scene.set_root(root);
    let first = scene.commit();
    assert_eq!(first.len(), 1, "first paint is a full flash");
    // the second task row is a tappable band at least 56 px tall, tiled under the first
    let line = scene.hit_line(60, 36 + 52 + 12 + 12 + 56 + 10);
    assert_eq!(line, Some(3), "tap in the second row reports source line 3");
    // toggling it damages that row only
    let toggled = text.replace("- [ ] two", "- [x] two");
    scene.set_props(md, &format!(r#"{{"text":{}}}"#, serde_json::to_string(&toggled).unwrap())).unwrap();
    let d = scene.commit();
    assert_eq!(d.len(), 1);
    assert!(d[0].rect.h <= 64 && d[0].rect.h >= 56, "one row: {:?}", d[0].rect);
    assert_eq!(d[0].mode, Mode::Du);
    save(&scene, "markdown.png");
}

/// First and last framebuffer rows with ink inside a rect.
fn ink_rows(s: &Scene, x: i32, y: i32, w: i32, h: i32) -> Option<(i32, i32)> {
    let fb = s.fb();
    let stride = SCREEN_W as usize;
    let mut first = None;
    let mut last = None;
    for yy in y..y + h {
        let row = &fb[yy as usize * stride + x as usize..yy as usize * stride + (x + w) as usize];
        if row.iter().any(|v| *v < 128) {
            first.get_or_insert(yy);
            last = Some(yy);
        }
    }
    Some((first?, last?))
}

#[test]
fn text_is_centred_in_a_taller_box() {
    // the same letter in two boxes taller than its line (72 px at 52 px bold): the glyph must
    // sit lower in the taller box by half the height difference, not at the top of both
    let mut s = Scene::new();
    let root = s.create(Kind::Box);
    s.set_props(root, r#"{"style":{"width":1072,"height":1448,"flex_direction":"row","gap":40,"padding":40},"bg":255}"#).unwrap();
    let snug = s.create(Kind::Text);
    s.set_props(snug, r#"{"text":"A","font_size":52,"bold":true,"align":"center","style":{"width":92,"height":80}}"#).unwrap();
    let tall = s.create(Kind::Text);
    s.set_props(tall, r#"{"text":"A","font_size":52,"bold":true,"align":"center","style":{"width":92,"height":160}}"#).unwrap();
    s.append(root, snug);
    s.append(root, tall);
    s.set_root(root);
    s.commit();
    let (snug_top, snug_bottom) = ink_rows(&s, 40, 40, 92, 80).expect("ink in the snug box");
    let (tall_top, tall_bottom) = ink_rows(&s, 172, 40, 92, 160).expect("ink in the tall box");
    assert_eq!(snug_bottom - snug_top, tall_bottom - tall_top, "same glyph height");
    let shift = tall_top - snug_top;
    assert!((39..=41).contains(&shift), "the taller box centres the glyph, shift {shift}");
}
