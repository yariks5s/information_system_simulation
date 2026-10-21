"""M3 acceptance, see RFC section 10"""
from engine import Engine
from pool import Pool, Task


def run(policy, threads, arrivals):
    """arrivals are (time, work, priority), returns {task id: completion time}"""
    engine = Engine()
    done = {}
    pool = Pool(engine, threads, 32, policy, lambda task: done.__setitem__(task.id, engine.now))
    for i, (at, work, priority) in enumerate(arrivals):
        engine.schedule(at, pool.add, Task(i, work, priority))
    engine.run()
    return done


def test_round_robin_shares_one_thread():
    assert run("round_robin", 1, [(0, 1, 1), (0, 2, 2)]) == {0: 2.0, 1: 3.0}


def test_round_robin_enough_threads():
    assert run("round_robin", 2, [(0, 1, 1), (0, 2, 2)]) == {0: 1.0, 1: 2.0}


def test_round_robin_late_arrival():
    # big runs alone for 0.5 s, then both at half speed
    assert run("round_robin", 1, [(0, 2, 200), (0.5, 1, 100)]) == {1: 2.5, 0: 3.0}


def test_shortest_task_first_preempts():
    assert run("shortest_task_first", 1, [(0, 2, 200), (0.5, 1, 100)]) == {1: 1.5, 0: 3.0}


def test_capacity():
    engine = Engine()
    pool = Pool(engine, 1, 2, "round_robin", lambda task: None)
    pool.add(Task(0, 1, 1))
    pool.add(Task(1, 1, 1))
    assert not pool.has_capacity()


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
            print("ok", name)
